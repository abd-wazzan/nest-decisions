import {
  type AnswersOf,
  Decision,
  DecisionsModule,
  from,
  Gate,
  type GateOutput,
  noul,
} from '@nest-decisions/core';
import { Body, Controller, type INestApplication, Injectable, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import request from 'supertest';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { type BullQueueLike, BullReviewQueue } from '../src';

const REDIS_URL = process.env.REDIS_URL;

describe('BullReviewQueue (unit)', () => {
  it('adds a job named "review" with the item and uses the job id as the review id', async () => {
    const add = vi.fn(async (_n: string, _d: unknown, o?: Record<string, unknown>) => ({
      id: String(o?.jobId),
    }));
    const q = new BullReviewQueue({ queue: { add } as BullQueueLike });
    const { id } = await q.enqueue({
      decision: 'RefundCheck',
      payload: { reason: 'x' },
      reason: 'amount',
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const [name, data, options] = add.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(name).toBe('review');
    expect(data).toMatchObject({
      decision: 'RefundCheck',
      payload: { reason: 'x' },
      reason: 'amount',
    });
    expect(new Date(data.queuedAt as string).toString()).not.toBe('Invalid Date');
    expect(options.jobId).toBe(id);
  });

  it('applies a custom job name and job options but never lets them override the job id', async () => {
    const add = vi.fn(async () => ({ id: 'from-bull' }));
    const q = new BullReviewQueue({
      queue: { add } as unknown as BullQueueLike,
      jobName: 'manual-review',
      jobOptions: { removeOnComplete: { age: 100 }, jobId: 'attacker-chosen' },
    });
    const { id } = await q.enqueue({ decision: 'D', payload: 1 });
    const call = add.mock.calls[0] as unknown as [string, unknown, Record<string, unknown>];
    expect(call[0]).toBe('manual-review');
    expect(call[2]).toMatchObject({ removeOnComplete: { age: 100 } });
    expect(call[2].jobId).not.toBe('attacker-chosen');
    expect(id).toBe('from-bull');
  });

  it('rejects when the queue is down, so the gate can fail closed', async () => {
    const q = new BullReviewQueue({
      queue: {
        add: async () => {
          throw new Error('ECONNREFUSED');
        },
      } as unknown as BullQueueLike,
    });
    await expect(q.enqueue({ decision: 'D', payload: 1 })).rejects.toThrow('ECONNREFUSED');
  });
});

describe.skipIf(!REDIS_URL)('BullReviewQueue (real Redis and BullMQ)', () => {
  const queues: Queue[] = [];
  let app: INestApplication | undefined;
  const makeQueue = () => {
    const url = new URL(REDIS_URL as string);
    const q = new Queue(`nd-test-${crypto.randomUUID()}`, {
      connection: {
        host: url.hostname,
        port: Number(url.port || 6379),
        db: Number(url.pathname.slice(1) || 0),
        maxRetriesPerRequest: null,
      },
    });
    queues.push(q);
    return q;
  };
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });
  afterAll(async () => {
    // Remove only the queues this test created.
    for (const q of queues) {
      await q.obliterate({ force: true });
      await q.close();
    }
  });

  it('stores the held request as a durable job a reviewer can read', async () => {
    const queue = makeQueue();
    const review = new BullReviewQueue({ queue });
    const { id } = await review.enqueue({
      decision: 'RefundCheck',
      payload: { reason: 'cracked' },
      reason: 'unsure',
    });
    const job = await queue.getJob(id);
    expect(job?.name).toBe('review');
    expect(job?.data).toMatchObject({
      decision: 'RefundCheck',
      payload: { reason: 'cracked' },
      reason: 'unsure',
    });
    expect(await job?.getState()).toBe('waiting');
    // A reviewer lists what is waiting and removes an item once a person has decided.
    const waiting = await queue.getJobs(['waiting']);
    expect(waiting.map((j) => j.id)).toContain(id);
    await job?.remove();
    expect(await queue.getJob(id)).toBeUndefined();
  });

  it('survives a "restart": a new Queue object over the same Redis still sees the job', async () => {
    const first = makeQueue();
    const { id } = await new BullReviewQueue({ queue: first }).enqueue({
      decision: 'D',
      payload: { a: 1 },
    });
    const again = new Queue(first.name, { connection: first.opts.connection });
    queues.push(again);
    expect((await again.getJob(id))?.data).toMatchObject({ payload: { a: 1 } });
  });

  it('works end to end behind a gate: 202 with the job id, and the job holds the redacted state', async () => {
    const questions = { ok: noul('Fine?') };
    @Injectable()
    class ReviewAll extends Decision<
      { text: string; secret: string },
      GateOutput,
      typeof questions
    > {
      readonly questions = questions;
      state(i: { text: string }) {
        return { text: i.text };
      }
      policy(_a: AnswersOf<typeof questions>): GateOutput {
        return { verdict: 'review', reason: 'always' };
      }
    }
    @Controller()
    class Api {
      @Gate({ decision: ReviewAll, input: (c) => from.httpBody(c) })
      @Post('go')
      go(@Body() _b: unknown) {
        return {};
      }
    }
    const queue = makeQueue();
    const mod = await Test.createTestingModule({
      imports: [
        DecisionsModule.forRoot({
          provider: {
            name: 'p',
            evaluate: async () => ({
              answers: { ok: { type: 'noul' as const, noul: 0.5 } },
              model: 'm',
              cost: { amount: 0, source: 'mock' as const },
            }),
          },
          audit: { record: () => {} },
          reviewQueue: new BullReviewQueue({ queue }),
        }),
      ],
      controllers: [Api],
      providers: [ReviewAll],
    }).compile();
    app = mod.createNestApplication();
    await app.init();

    const res = await request(app.getHttpServer())
      .post('/go')
      .send({ text: 'hello', secret: 'card-4242' });
    expect(res.status).toBe(202);
    const job = await queue.getJob(res.body.reviewId);
    expect(job?.data).toMatchObject({
      decision: 'ReviewAll',
      payload: { text: 'hello' },
      reason: 'always',
    });
    expect(JSON.stringify(job?.data)).not.toContain('card-4242');
  });

  it('fails closed (503) when Redis cannot take the job', async () => {
    const questions = { ok: noul('Fine?') };
    @Injectable()
    class ReviewAll extends Decision<{ text: string }, GateOutput, typeof questions> {
      readonly questions = questions;
      state(i: { text: string }) {
        return { text: i.text };
      }
      policy(_a: AnswersOf<typeof questions>): GateOutput {
        return 'review';
      }
    }
    @Controller()
    class Api {
      @Gate({ decision: ReviewAll, input: (c) => from.httpBody(c) })
      @Post('go')
      go(@Body() _b: unknown) {
        return {};
      }
    }
    const mod = await Test.createTestingModule({
      imports: [
        DecisionsModule.forRoot({
          provider: {
            name: 'p',
            evaluate: async () => ({
              answers: { ok: { type: 'noul' as const, noul: 0.5 } },
              model: 'm',
              cost: { amount: 0, source: 'mock' as const },
            }),
          },
          audit: { record: () => {} },
          reviewQueue: new BullReviewQueue({
            queue: {
              add: async () => {
                throw new Error('ECONNREFUSED');
              },
            } as unknown as BullQueueLike,
          }),
        }),
      ],
      controllers: [Api],
      providers: [ReviewAll],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
    const res = await request(app.getHttpServer()).post('/go').send({ text: 'hello' });
    expect(res.status).toBe(503);
  });
});
