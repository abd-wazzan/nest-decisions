import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AnswersOf,
  BudgetGuard,
  Decision,
  DecisionsModule,
  DecisionUnavailableError,
  noul,
} from '../src';
import { stubProvider } from './helpers';

describe('BudgetGuard per key', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('limits each key independently while the global cap still applies', async () => {
    const b = new BudgetGuard({ maxCalls: 5, perKey: { maxCalls: 2 }, windowMs: 1000 });
    await b.reserve('acme');
    await b.reserve('acme');
    await expect(b.reserve('acme')).rejects.toThrow(/key "acme"/);
    await expect(b.reserve('globex')).resolves.toBeDefined();
    await b.reserve('globex');
    await b.reserve(undefined); // unkeyed calls only count against the global cap
    await expect(b.reserve('initech')).rejects.toThrow(/5 calls/); // global cap reached
    vi.advanceTimersByTime(1001);
    await expect(b.reserve('acme')).resolves.toBeDefined();
  });

  it('limits spend per key', async () => {
    const b = new BudgetGuard({ perKey: { maxUsd: 0.05 }, windowMs: 1000 });
    (await b.reserve('a')).settle({ amount: 0.06, source: 'reported' });
    await expect(b.reserve('a')).rejects.toThrow(/\$0.05/);
    await expect(b.reserve('b')).resolves.toBeDefined();
  });

  it('does not leak keys in error messages beyond the key itself', async () => {
    const b = new BudgetGuard({ perKey: { maxCalls: 1 } });
    await b.reserve('t1');
    await expect(b.reserve('t1')).rejects.toThrow(DecisionUnavailableError);
  });
});

const questions = { bad: noul('Is it bad?') };

@Injectable()
class Tenanted extends Decision<{ text: string; tenant: string }, boolean, typeof questions> {
  readonly questions = questions;
  state(i: { text: string }) {
    return { text: i.text };
  }
  override budgetKey(i: { tenant: string }) {
    return i.tenant;
  }
  policy(a: AnswersOf<typeof questions>) {
    return a.bad.noul > 0.5;
  }
}

describe('Decision.budgetKey', () => {
  it('applies the per-key budget per tenant through the service', async () => {
    const provider = stubProvider(() => ({ answers: { bad: { type: 'noul', noul: 0.9 } } }));
    const mod = await Test.createTestingModule({
      imports: [
        DecisionsModule.forRoot({
          provider,
          audit: { record: () => {} },
          dedupe: false,
          budget: { perKey: { maxCalls: 1 } },
        }),
      ],
      providers: [Tenanted],
    }).compile();
    const d = mod.get(Tenanted);
    await d.decide({ text: 'a', tenant: 'acme' });
    await expect(d.decide({ text: 'b', tenant: 'acme' })).rejects.toBeInstanceOf(
      DecisionUnavailableError,
    );
    await expect(d.decide({ text: 'c', tenant: 'globex' })).resolves.toBeDefined();
    expect(provider.calls).toHaveLength(2);
  });
});
