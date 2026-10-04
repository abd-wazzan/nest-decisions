import { Body, Controller, type INestApplication, Injectable, Module, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AnswersOf,
  type AuditEntry,
  Decision,
  DecisionsModule,
  from,
  Gate,
  type GateOutput,
  noul,
  verdictFromRisk,
} from '../src';
import { stubProvider } from './helpers';

const questions = { bad: noul('Is it abusive?') };

@Injectable()
class AbuseCheck extends Decision<{ text: string; userId: string }, GateOutput, typeof questions> {
  readonly questions = questions;
  state(i: { text: string; userId: string }) {
    return { text: i.text };
  }
  policy(a: AnswersOf<typeof questions>): GateOutput {
    return verdictFromRisk(a.bad.noul, { blockAbove: 0.8, reviewAbove: 0.3 });
  }
}

@Controller()
class Api {
  @Gate({ decision: AbuseCheck, input: (c) => from.httpBody(c) })
  @Post('post')
  post(@Body() b: { text: string }) {
    return { ok: b.text };
  }
}

let app: INestApplication | undefined;
afterEach(async () => app?.close());

const body = { text: 'hello there', userId: 'u-77' };

async function boot(p: number | 'fail', extra: Record<string, unknown> = {}) {
  const provider = stubProvider(() => {
    if (p === 'fail') throw new Error('down');
    return { answers: { bad: { type: 'noul', noul: p } } };
  });
  const entries: AuditEntry[] = [];
  const mod = await Test.createTestingModule({
    imports: [
      DecisionsModule.forRoot({
        provider,
        audit: { record: (e) => void entries.push(e) },
        ...extra,
      }),
    ],
    controllers: [Api],
    providers: [AbuseCheck],
  }).compile();
  app = mod.createNestApplication();
  await app.init();
  return entries;
}

describe('gate auditing', () => {
  it('records the verdict for every gated request', async () => {
    const entries = await boot(0.95);
    await request(app?.getHttpServer()).post('/post').send(body);
    const gated = entries.find((e) => e.outcome === 'gated');
    expect(gated).toMatchObject({ decision: 'AbuseCheck', verdict: 'block' });
    expect(gated?.stateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(entries)).not.toContain('hello there');
  });

  it('audits fail-closed outages as errors with the state hash', async () => {
    const entries = await boot('fail');
    const res = await request(app?.getHttpServer()).post('/post').send(body);
    expect(res.status).toBe(503);
    expect(entries.find((e) => e.outcome === 'error')).toMatchObject({
      decision: 'AbuseCheck',
      error: expect.stringContaining('down'),
    });
    expect(entries.find((e) => e.outcome === 'error')?.stateHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('uses an HMAC when a hash secret is configured', async () => {
    const plain = await boot(0.1);
    await request(app?.getHttpServer()).post('/post').send(body);
    const a = plain.find((e) => e.outcome === 'gated')?.stateHash;
    await app?.close();
    const keyed = await boot(0.1, { hashSecret: 'pepper' });
    await request(app?.getHttpServer()).post('/post').send(body);
    expect(keyed.find((e) => e.outcome === 'gated')?.stateHash).not.toBe(a);
  });
});

describe('review queue failures', () => {
  it('fails closed with 503 when the queue refuses the item', async () => {
    await boot(0.5, {
      reviewQueue: {
        enqueue: async () => {
          throw new Error('queue full');
        },
      },
    });
    const res = await request(app?.getHttpServer()).post('/post').send(body);
    expect(res.status).toBe(503);
  });

  it('lets a gate override what a reviewer receives', async () => {
    const seen: unknown[] = [];
    @Controller()
    class Api2 {
      @Gate({
        decision: AbuseCheck,
        input: (c) => from.httpBody(c),
        reviewPayload: (i: { userId: string }) => ({ userId: i.userId }),
      })
      @Post('x')
      x() {
        return {};
      }
    }
    const mod = await Test.createTestingModule({
      imports: [
        DecisionsModule.forRoot({
          provider: stubProvider(() => ({ answers: { bad: { type: 'noul', noul: 0.5 } } })),
          audit: { record: () => {} },
          reviewQueue: {
            enqueue: async (item) => {
              seen.push(item.payload);
              return { id: 'r1' };
            },
          },
        }),
      ],
      controllers: [Api2],
      providers: [AbuseCheck],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
    const res = await request(app.getHttpServer()).post('/x').send(body);
    expect(res.status).toBe(202);
    expect(seen).toEqual([{ userId: 'u-77' }]);
  });
});

describe('module scoping', () => {
  it('supports isGlobal: false by importing the module where it is used', async () => {
    @Module({
      imports: [
        DecisionsModule.forRoot({
          isGlobal: false,
          provider: stubProvider(() => ({ answers: { bad: { type: 'noul', noul: 0.01 } } })),
          audit: { record: () => {} },
        }),
      ],
      controllers: [Api],
      providers: [AbuseCheck],
    })
    class Feature {}
    const mod = await Test.createTestingModule({ imports: [Feature] }).compile();
    app = mod.createNestApplication();
    await app.init();
    const res = await request(app.getHttpServer()).post('/post').send(body);
    expect(res.status).toBe(201);
  });
});
