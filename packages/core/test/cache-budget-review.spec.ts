import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BudgetGuard,
  DecisionUnavailableError,
  type EvaluateResult,
  InMemoryReviewQueue,
  MemoryDecisionCache,
} from '../src';

const result = (model = 'm'): EvaluateResult => ({
  answers: {},
  model,
  cost: { amount: 0.01, source: 'reported' },
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('MemoryDecisionCache', () => {
  it('returns clones and expires entries', async () => {
    const cache = new MemoryDecisionCache({ ttlMs: 1000 });
    cache.set('k', result('a'));
    const hit = cache.get('k');
    expect(hit?.model).toBe('a');
    (hit as EvaluateResult).model = 'mutated';
    expect(cache.get('k')?.model).toBe('a');
    vi.advanceTimersByTime(1001);
    expect(cache.get('k')).toBeUndefined();
    expect(cache.get('missing')).toBeUndefined();
  });

  it('evicts the oldest beyond maxEntries and rejects a bad ttl', async () => {
    const cache = new MemoryDecisionCache({ ttlMs: 1000, maxEntries: 2 });
    cache.set('a', result());
    cache.set('b', result());
    cache.set('c', result());
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
    expect(() => new MemoryDecisionCache({ ttlMs: 0 })).toThrow(/ttlMs/);
  });
});

describe('BudgetGuard', () => {
  it('caps calls per rolling window, counting every reservation', async () => {
    const budget = new BudgetGuard({ maxCalls: 2, windowMs: 1000 });
    (await budget.reserve()).settle({ amount: null, source: 'unknown' });
    await budget.reserve(); // never settled, e.g. a failed or timed-out call: still counts
    await expect(budget.reserve()).rejects.toBeInstanceOf(DecisionUnavailableError);
    vi.advanceTimersByTime(1001);
    await expect(budget.reserve()).resolves.toBeDefined();
  });

  it('caps spend, counting unknown cost as zero', async () => {
    const budget = new BudgetGuard({ maxUsd: 0.015 });
    (await budget.reserve()).settle({ amount: 0.01, source: 'reported' });
    (await budget.reserve()).settle({ amount: null, source: 'unknown' });
    await expect(budget.reserve()).resolves.toBeDefined();
    const fresh = new BudgetGuard({ maxUsd: 0.015 });
    (await fresh.reserve()).settle({ amount: 0.01, source: 'reported' });
    (await fresh.reserve()).settle({ amount: 0.01, source: 'estimated' });
    await expect(fresh.reserve()).rejects.toThrow(/\$0.015/);
  });

  it('rejects a bad window', async () => {
    expect(() => new BudgetGuard({ windowMs: 0 })).toThrow(/windowMs/);
  });
});

describe('InMemoryReviewQueue', () => {
  it('stores items under random ids', async () => {
    const q = new InMemoryReviewQueue();
    const a = await q.enqueue({ decision: 'D', payload: { a: 1 }, reason: 'r' });
    const b = await q.enqueue({ decision: 'D', payload: 2 });
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.id).not.toBe(b.id);
    expect(q.items[0]).toMatchObject({ decision: 'D', reason: 'r', id: a.id });
  });

  it('refuses new items when full instead of growing without bound', async () => {
    const q = new InMemoryReviewQueue(1);
    await q.enqueue({ decision: 'D', payload: 1 });
    await expect(q.enqueue({ decision: 'D', payload: 2 })).rejects.toThrow(/full/);
  });
});
