import { Body, Controller, type INestApplication, Injectable, Post } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AnswersOf,
  choice,
  Decision,
  DecisionsModule,
  from,
  Gate,
  type GateOutput,
  InMemoryReviewQueue,
  noul,
  verdictFromRisk,
  verdictFromTrust,
} from '../src';
import { stubProvider } from './helpers';

const questions = { legit: noul('Is this refund request legitimate?') };

@Injectable()
class RefundCheck extends Decision<
  { orderId: string; reason: string },
  GateOutput,
  typeof questions
> {
  readonly questions = questions;
  state(i: { orderId: string; reason: string }) {
    return { reason: i.reason };
  }
  policy(a: AnswersOf<typeof questions>): GateOutput {
    const verdict = verdictFromTrust(a.legit.noul, { allowAbove: 0.9, reviewAbove: 0.5 });
    return { verdict, reason: `legit=${a.legit.noul}` };
  }
}

@Controller()
class RefundController {
  @Gate({ decision: RefundCheck, input: (c) => from.httpBody(c) })
  @Post('refund')
  refund(@Body() dto: { orderId: string }) {
    return { refunded: dto.orderId };
  }
}

let app: INestApplication | NestFastifyApplication | undefined;
afterEach(async () => app?.close());

async function boot(noulValue: number | 'fail', fastify = false) {
  const provider = stubProvider(() => {
    if (noulValue === 'fail') throw new Error('provider down');
    return { answers: { legit: { type: 'noul', noul: noulValue } } };
  });
  const queue = new InMemoryReviewQueue();
  const mod = await Test.createTestingModule({
    imports: [
      DecisionsModule.forRoot({ provider, reviewQueue: queue, audit: { record: () => {} } }),
    ],
    controllers: [RefundController],
    providers: [RefundCheck],
  }).compile();
  app = fastify
    ? mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    : mod.createNestApplication();
  await app.init();
  if (fastify) await (app as NestFastifyApplication).getHttpAdapter().getInstance().ready();
  return { queue, provider };
}

const body = { orderId: 'o-1', reason: 'item arrived broken' };

describe('@Gate on Express', () => {
  it('allows high-trust requests', async () => {
    await boot(0.95);
    const res = await request(app?.getHttpServer()).post('/refund').send(body);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ refunded: 'o-1' });
  });

  it('queues mid-trust requests for review and does not run the handler', async () => {
    const { queue } = await boot(0.7);
    const res = await request(app?.getHttpServer()).post('/refund').send(body);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'pending_review' });
    expect(res.body.reviewId).toMatch(/^[0-9a-f-]{36}$/);
    // The reviewer gets the redacted state the model saw, not the raw request (no orderId).
    expect(queue.items[0]).toMatchObject({
      decision: 'RefundCheck',
      payload: { reason: 'item arrived broken' },
    });
    expect(JSON.stringify(queue.items[0])).not.toContain('o-1');
  });

  it('blocks low-trust requests without leaking the reason', async () => {
    await boot(0.1);
    const res = await request(app?.getHttpServer()).post('/refund').send(body);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('legit=');
  });

  it('fails closed with 503 when the decision cannot be made', async () => {
    await boot('fail');
    const res = await request(app?.getHttpServer()).post('/refund').send(body);
    expect(res.status).toBe(503);
  });

  it('sends only the decision-chosen state to the provider', async () => {
    const { provider } = await boot(0.95);
    await request(app?.getHttpServer()).post('/refund').send(body);
    expect(provider.calls[0]?.state).toEqual({ reason: 'item arrived broken' });
  });
});

describe('@Gate on Fastify', () => {
  it('allows and blocks the same way', async () => {
    await boot(0.95, true);
    const ok = await (app as NestFastifyApplication).inject({
      method: 'POST',
      url: '/refund',
      payload: body,
    });
    expect(ok.statusCode).toBe(201);
    await app?.close();
    await boot(0.1, true);
    const blocked = await (app as NestFastifyApplication).inject({
      method: 'POST',
      url: '/refund',
      payload: body,
    });
    expect(blocked.statusCode).toBe(403);
  });
});

describe('verdict helpers', () => {
  it('maps risk and trust probabilities to verdicts', () => {
    const risk = { blockAbove: 0.85, reviewAbove: 0.5 };
    expect([0.9, 0.6, 0.2].map((p) => verdictFromRisk(p, risk))).toEqual([
      'block',
      'review',
      'allow',
    ]);
    const trust = { allowAbove: 0.9, reviewAbove: 0.5 };
    expect([0.95, 0.5, 0.49].map((p) => verdictFromTrust(p, trust))).toEqual([
      'allow',
      'review',
      'block',
    ]);
  });
});

describe('from helpers', () => {
  it('reads http query, rpc payload and positional args', () => {
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({ body: 'b', query: 'q' }) }),
      switchToRpc: () => ({ getData: () => 'rpc' }),
      getArgs: () => ['a0', 'a1'],
    } as never;
    expect(from.httpBody(ctx)).toBe('b');
    expect(from.httpQuery(ctx)).toBe('q');
    expect(from.rpcPayload(ctx)).toBe('rpc');
    expect(from.arg(1)(ctx)).toBe('a1');
    void choice;
  });
});
