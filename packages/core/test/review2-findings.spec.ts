/**
 * Regression tests for the second round of review findings (fail-open edges and contracts).
 */
import { Body, Controller, type INestApplication, Injectable, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AnswersOf,
  type AuditEntry,
  type CachedResult,
  candidateFrom,
  Decision,
  type DecisionCache,
  DecisionsModule,
  DecisionUnavailableError,
  from,
  Gate,
  type GateOutput,
  noul,
  shadowRun,
  verdictFromTrust,
} from '../src';
import { stubProvider } from './helpers';

const questions = { ok: noul('Is it fine?') };
const answer = (p: number) => ({ answers: { ok: { type: 'noul' as const, noul: p } } });

@Injectable()
class Plain extends Decision<{ text: string }, boolean, typeof questions> {
  readonly questions = questions;
  state(i: { text: string }) {
    return { text: i.text };
  }
  policy(a: AnswersOf<typeof questions>) {
    return a.ok.noul > 0.5;
  }
}

describe('cache hits are validated like fresh answers', () => {
  it.each([
    ['null probability', { ok: { type: 'noul', noul: null } }],
    ['missing answers', {}],
    ['wrong type', { ok: { type: 'choice', choice: 'x' } }],
  ])('treats a cached %s as a miss and asks the provider', async (_n, bad) => {
    const cache: DecisionCache = {
      get: async () =>
        ({
          answers: bad,
          model: 'm',
          cost: { amount: 0, source: 'mock' },
        }) as unknown as CachedResult,
      set: async () => {},
    };
    const provider = stubProvider(() => answer(0.9));
    const mod = await Test.createTestingModule({
      imports: [DecisionsModule.forRoot({ provider, cache, audit: { record: () => {} } })],
      providers: [Plain],
    }).compile();
    expect((await mod.get(Plain).decide({ text: 't' })).decision).toBe(true);
    expect(provider.calls).toHaveLength(1);
  });

  it('keys the cache by provider so a swapped provider never reads the old answers', async () => {
    const store = new Map<string, CachedResult>();
    const cache: DecisionCache = {
      get: (k) => store.get(k),
      set: (k, v) => void store.set(k, v),
    };
    const run = async (name: string, p: number) => {
      const provider = { ...stubProvider(() => answer(p)), name };
      const mod = await Test.createTestingModule({
        imports: [DecisionsModule.forRoot({ provider, cache, audit: { record: () => {} } })],
        providers: [Plain],
      }).compile();
      return (await mod.get(Plain).decide({ text: 'same' })).decision;
    };
    expect(await run('provider-a', 0.9)).toBe(true);
    expect(await run('provider-b', 0.1)).toBe(false);
  });
});

describe('a decision must come from Nest', () => {
  it('explains itself instead of crashing on undefined', async () => {
    await expect(new Plain().decide({ text: 't' })).rejects.toThrow(/created by Nest/);
  });
});

describe('fallback failures are audited', () => {
  it('records an error entry and rethrows', async () => {
    @Injectable()
    class BadFallback extends Plain {
      override fallback(): boolean {
        throw new Error('fallback bug');
      }
    }
    const entries: AuditEntry[] = [];
    const provider = stubProvider(() => {
      throw new Error('down');
    });
    const mod = await Test.createTestingModule({
      imports: [
        DecisionsModule.forRoot({ provider, audit: { record: (e) => void entries.push(e) } }),
      ],
      providers: [BadFallback],
    }).compile();
    await expect(mod.get(BadFallback).decide({ text: 't' })).rejects.toThrow('fallback bug');
    expect(entries.at(-1)).toMatchObject({
      outcome: 'error',
      error: expect.stringContaining('fallback failed'),
    });
  });
});

describe('budget counts provider attempts', () => {
  it('a result that took three attempts uses three slots', async () => {
    const provider = stubProvider(() => ({ ...answer(0.9), attempts: 3 }));
    const mod = await Test.createTestingModule({
      imports: [
        DecisionsModule.forRoot({
          provider,
          dedupe: false,
          audit: { record: () => {} },
          budget: { maxCalls: 4 },
        }),
      ],
      providers: [Plain],
    }).compile();
    const d = mod.get(Plain);
    await d.decide({ text: 'a' }); // 3 slots
    await d.decide({ text: 'b' }); // 4th slot, then settled at 3 attempts => 6 used
    await expect(d.decide({ text: 'c' })).rejects.toBeInstanceOf(DecisionUnavailableError);
    expect(provider.calls).toHaveLength(2);
  });
});

describe('shadow candidates that fall back are not disagreements', () => {
  it('candidateFrom rejects when the decision fell back, so the report carries an error', async () => {
    @Injectable()
    class WithFallback extends Plain {
      override fallback() {
        return false;
      }
    }
    const provider = stubProvider(() => {
      throw new Error('down');
    });
    const mod = await Test.createTestingModule({
      imports: [DecisionsModule.forRoot({ provider, audit: { record: () => {} } })],
      providers: [WithFallback],
    }).compile();
    const { shadow } = await shadowRun({
      name: 's',
      legacy: () => true,
      candidate: candidateFrom(mod.get(WithFallback), { text: 't' }),
      report: () => {},
    });
    const report = await shadow;
    expect(report.agreed).toBe(false);
    expect(report.error).toMatch(/fell back/);
  });
});

// ---------- Gate contract ----------

type Out = GateOutput | null | string;

function gateApp(
  policyOut: (p: number) => Out,
  opts: {
    fallback?: GateOutput;
    gate?: Record<string, unknown>;
    stateSpy?: () => void;
    p?: number | 'fail';
  } = {},
) {
  @Injectable()
  class Check extends Decision<{ text: string }, GateOutput, typeof questions> {
    readonly questions = questions;
    state(i: { text: string }) {
      opts.stateSpy?.();
      return { text: i.text };
    }
    policy(a: AnswersOf<typeof questions>) {
      return policyOut(a.ok.noul) as GateOutput;
    }
    override fallback() {
      return opts.fallback as GateOutput;
    }
  }
  if (opts.fallback === undefined) (Check.prototype as { fallback?: unknown }).fallback = undefined;

  @Controller()
  class Api {
    @Gate({ decision: Check, input: (c) => from.httpBody(c), ...(opts.gate ?? {}) })
    @Post('go')
    go(@Body() b: { text: string }) {
      return { ran: b.text };
    }
  }
  const provider = stubProvider(() => {
    if (opts.p === 'fail') throw new Error('down');
    return answer(opts.p ?? 0.9);
  });
  return { Check, Api, provider };
}

let app: INestApplication | undefined;
afterEach(async () => app?.close());

async function boot(g: ReturnType<typeof gateApp>, extra: Record<string, unknown> = {}) {
  const entries: AuditEntry[] = [];
  const mod = await Test.createTestingModule({
    imports: [
      DecisionsModule.forRoot({
        provider: g.provider,
        audit: { record: (e) => void entries.push(e) },
        ...extra,
      }),
    ],
    controllers: [g.Api],
    providers: [g.Check],
  }).compile();
  app = mod.createNestApplication();
  await app.init();
  return entries;
}
const post = () => request(app?.getHttpServer()).post('/go').send({ text: 'hi' });

describe('@Gate and fallbacks', () => {
  it('never lets a request through on a fallback "allow" unless the gate opts in', async () => {
    await boot(gateApp(() => 'allow', { fallback: 'allow', p: 'fail' }));
    expect((await post()).status).toBe(503);
  });

  it('lets a fallback "allow" through when allowOnFallback is set', async () => {
    await boot(
      gateApp(() => 'allow', { fallback: 'allow', p: 'fail', gate: { allowOnFallback: true } }),
    );
    expect((await post()).status).toBe(201);
  });

  it('honors a fallback "review" and "block"', async () => {
    await boot(gateApp(() => 'allow', { fallback: 'review', p: 'fail' }));
    expect((await post()).status).toBe(202);
    await app?.close();
    await boot(gateApp(() => 'allow', { fallback: 'block', p: 'fail' }));
    expect((await post()).status).toBe(403);
  });
});

describe('@Gate with a broken policy', () => {
  it.each([null, 'maybe', { verdict: 'perhaps' }, undefined])(
    'fails closed with 503 on %j',
    async (out) => {
      const entries = await boot(gateApp(() => out as Out));
      expect((await post()).status).toBe(503);
      expect(entries.some((e) => e.outcome === 'error' && /verdict/i.test(e.error ?? ''))).toBe(
        true,
      );
    },
  );
});

describe('@Gate review path', () => {
  it('computes state once and gives reviewers exactly the state the model saw', async () => {
    const stateSpy = vi.fn();
    const items: unknown[] = [];
    await boot(
      gateApp(() => 'review', { stateSpy }),
      {
        reviewQueue: {
          enqueue: async (i: { payload: unknown }) => {
            items.push(i.payload);
            return { id: 'r' };
          },
        },
      },
    );
    await post();
    expect(stateSpy).toHaveBeenCalledTimes(1);
    expect(items).toEqual([{ text: 'hi' }]);
  });

  it('supports a configurable review status', async () => {
    await boot(gateApp(() => 'review', { gate: { reviewStatus: 409 } }));
    const res = await post();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ status: 'pending_review' });
  });

  it('lets non-HTTP transports map outcomes with an exceptionFactory', async () => {
    const seen: string[] = [];
    class Denied extends Error {}
    await boot(
      gateApp(() => 'block', {
        gate: {
          exceptionFactory: (d: { kind: string }) => {
            seen.push(d.kind);
            return new Denied(d.kind);
          },
        },
      }),
    );
    await post();
    expect(seen).toEqual(['block']);
    void verdictFromTrust;
  });
});
