import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import {
  type AnswersOf,
  type AuditEntry,
  Decision,
  DecisionsModule,
  DecisionUnavailableError,
  noul,
} from '../src';
import { stubProvider } from './helpers';

const questions = { bad: noul('Is it bad?') };

@Injectable()
class Check extends Decision<{ text: string }, boolean, typeof questions> {
  readonly questions = questions;
  state(i: { text: string }) {
    return { text: i.text };
  }
  policy(a: AnswersOf<typeof questions>) {
    if (a.bad.noul === 0.123) throw new Error('policy bug');
    return a.bad.noul > 0.5;
  }
}

const ok = { bad: { type: 'noul' as const, noul: 0.9 } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function build(
  provider: ReturnType<typeof stubProvider>,
  extra: Record<string, unknown> = {},
) {
  const entries: AuditEntry[] = [];
  const mod = await Test.createTestingModule({
    imports: [
      DecisionsModule.forRoot({
        provider,
        audit: { record: (e) => void entries.push(e) },
        ...extra,
      }),
    ],
    providers: [Check],
  }).compile();
  return { check: mod.get(Check), entries };
}

describe('identical in-flight calls share one provider call', () => {
  it('collapses concurrent identical requests and marks followers as not calling the provider', async () => {
    const provider = stubProvider(async () => {
      await wait(20);
      return { answers: ok };
    });
    const { check } = await build(provider, { budget: { maxCalls: 1 } });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => check.decide({ text: 'same' })),
    );
    expect(provider.calls).toHaveLength(1);
    expect(results.every((r) => r.decision === true)).toBe(true);
    const cached = results.map((r) => !r.result.fromFallback && r.result.cached);
    expect(cached.filter(Boolean)).toHaveLength(9);
  });

  it('does not share different states', async () => {
    const provider = stubProvider(async () => {
      await wait(10);
      return { answers: ok };
    });
    const { check } = await build(provider);
    await Promise.all([check.decide({ text: 'a' }), check.decide({ text: 'b' })]);
    expect(provider.calls).toHaveLength(2);
  });

  it('shares a failure with every waiter, then allows a fresh attempt', async () => {
    let fail = true;
    const provider = stubProvider(async () => {
      await wait(10);
      if (fail) throw new Error('down');
      return { answers: ok };
    });
    const { check } = await build(provider);
    const settled = await Promise.allSettled(
      Array.from({ length: 3 }, () => check.decide({ text: 'x' })),
    );
    expect(settled.every((s) => s.status === 'rejected')).toBe(true);
    expect(provider.calls).toHaveLength(1);
    expect((settled[0] as PromiseRejectedResult).reason).toBeInstanceOf(DecisionUnavailableError);
    fail = false;
    expect((await check.decide({ text: 'x' })).decision).toBe(true);
    expect(provider.calls).toHaveLength(2);
  });

  it('can be switched off', async () => {
    const provider = stubProvider(async () => {
      await wait(10);
      return { answers: ok };
    });
    const { check } = await build(provider, { dedupe: false });
    await Promise.all([check.decide({ text: 'same' }), check.decide({ text: 'same' })]);
    expect(provider.calls).toHaveLength(2);
  });
});

describe('a throwing policy is audited', () => {
  it('records an error entry and rethrows the original error', async () => {
    const provider = stubProvider(() => ({ answers: { bad: { type: 'noul', noul: 0.123 } } }));
    const { check, entries } = await build(provider);
    await expect(check.decide({ text: 't' })).rejects.toThrow('policy bug');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      outcome: 'error',
      decision: 'Check',
      error: expect.stringContaining('policy bug'),
    });
    expect(entries[0]?.stateHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('late results are still costed', () => {
  it('counts the cost of a call that finished after the timeout', async () => {
    const provider = stubProvider(async () => {
      await wait(60);
      return { answers: ok, cost: { amount: 0.05, source: 'reported' } };
    });
    const { check } = await build(provider, {
      timeoutMs: 20,
      budget: { maxUsd: 0.04, windowMs: 10_000 },
    });
    await expect(check.decide({ text: 'a' })).rejects.toBeInstanceOf(DecisionUnavailableError);
    await wait(100); // the provider finishes after the timeout and reports its cost
    await expect(check.decide({ text: 'b' })).rejects.toThrow(/Budget exceeded/);
    expect(provider.calls).toHaveLength(1);
  });
});
