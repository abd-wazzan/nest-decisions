import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import {
  type AnswersOf,
  type BudgetReservation,
  type BudgetReserveRequest,
  type BudgetStore,
  Decision,
  DecisionsModule,
  DecisionUnavailableError,
  MemoryBudgetStore,
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
    return a.bad.noul > 0.5;
  }
}

const build = async (
  store: BudgetStore,
  provider = stubProvider(() => ({ answers: { bad: { type: 'noul', noul: 0.9 } } })),
) => {
  const mod = await Test.createTestingModule({
    imports: [
      DecisionsModule.forRoot({
        provider,
        dedupe: false,
        audit: { record: () => {} },
        budget: { maxCalls: 1, store },
      }),
    ],
    providers: [Check],
  }).compile();
  return { check: mod.get(Check), provider };
};

describe('pluggable budget store', () => {
  it('uses the provided store and passes the limits and key', async () => {
    const seen: BudgetReserveRequest[] = [];
    const store: BudgetStore = {
      reserve: async (r) => {
        seen.push(r);
        return { settle: () => {} };
      },
    };
    const { check } = await build(store);
    await check.decide({ text: 'a' });
    expect(seen[0]).toMatchObject({ windowMs: 60_000, global: { maxCalls: 1 } });
  });

  it('fails closed when the store rejects, without calling the provider', async () => {
    const store: BudgetStore = {
      reserve: async () => {
        throw new DecisionUnavailableError('Budget exceeded: shared store says no.');
      },
    };
    const { check, provider } = await build(store);
    await expect(check.decide({ text: 'a' })).rejects.toThrow(/shared store says no/);
    expect(provider.calls).toHaveLength(0);
  });

  it('a store that is down also fails closed', async () => {
    const store: BudgetStore = {
      reserve: async () => {
        throw new Error('ECONNREFUSED');
      },
    };
    const { check, provider } = await build(store);
    await expect(check.decide({ text: 'a' })).rejects.toBeInstanceOf(DecisionUnavailableError);
    expect(provider.calls).toHaveLength(0);
  });

  it('never lets a failing settle change the outcome of a call that already happened', async () => {
    const store: BudgetStore = {
      reserve: async (): Promise<BudgetReservation> => ({
        settle: async () => {
          throw new Error('redis went away');
        },
      }),
    };
    const { check } = await build(store);
    expect((await check.decide({ text: 'a' })).decision).toBe(true);
  });
});

describe('MemoryBudgetStore', () => {
  it('is atomic under concurrency', async () => {
    const store = new MemoryBudgetStore();
    const request: BudgetReserveRequest = { windowMs: 10_000, global: { maxCalls: 5 } };
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => store.reserve(request)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
  });
});
