import {
  type BudgetReserveRequest,
  type BudgetStore,
  DecisionUnavailableError,
} from '@nest-decisions/core';

/** The slice of a test framework the contract needs, so it works with Vitest or Jest. */
export interface TestApi {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => Promise<void> | void) => void;
  expect: (value: unknown) => {
    toBe(expected: unknown): void;
    rejects: {
      toBeInstanceOf(c: unknown): Promise<void>;
      toThrow(m?: RegExp | string): Promise<void>;
    };
    resolves: { toBeDefined(): Promise<void> };
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Behavior every `BudgetStore` must have. Run it against your own store:
 *
 *   budgetStoreContract({ describe, it, expect }, 'MyStore', () => new MyStore(...));
 *
 * `makeStore` must return a store with no counters yet (use a unique key prefix per call).
 */
export function budgetStoreContract(
  { describe, it, expect }: TestApi,
  name: string,
  makeStore: () => BudgetStore | Promise<BudgetStore>,
): void {
  const request = (over: Partial<BudgetReserveRequest> = {}): BudgetReserveRequest => ({
    windowMs: 60_000,
    global: {},
    ...over,
  });

  describe(`BudgetStore contract: ${name}`, () => {
    it('caps calls and rejects with DecisionUnavailableError', async () => {
      const store = await makeStore();
      const r = request({ global: { maxCalls: 2 } });
      await store.reserve(r);
      await store.reserve(r);
      await expect(store.reserve(r)).rejects.toBeInstanceOf(DecisionUnavailableError);
      await expect(store.reserve(r)).rejects.toThrow(/2 calls/);
    });

    it('counts reservations that are never settled', async () => {
      const store = await makeStore();
      const r = request({ global: { maxCalls: 1 } });
      await store.reserve(r); // e.g. a call that failed or timed out
      await expect(store.reserve(r)).rejects.toBeInstanceOf(DecisionUnavailableError);
    });

    it('limits each key independently while the global cap still applies', async () => {
      const store = await makeStore();
      const limits = { global: { maxCalls: 4 }, perKey: { maxCalls: 1 } };
      await store.reserve(request({ ...limits, key: 'acme' }));
      await expect(store.reserve(request({ ...limits, key: 'acme' }))).rejects.toThrow(
        /key "acme"/,
      );
      await expect(store.reserve(request({ ...limits, key: 'globex' }))).resolves.toBeDefined();
      await store.reserve(request({ ...limits })); // unkeyed: only the global cap
      await store.reserve(request({ ...limits, key: 'initech' }));
      await expect(store.reserve(request({ ...limits, key: 'hooli' }))).rejects.toThrow(/4 calls/);
    });

    it('caps spend, counting unknown cost as zero', async () => {
      const store = await makeStore();
      const r = request({ global: { maxUsd: 0.05 } });
      await (await store.reserve(r)).settle({ amount: null, source: 'unknown' });
      await (await store.reserve(r)).settle({ amount: 0.06, source: 'reported' });
      await expect(store.reserve(r)).rejects.toThrow(/\$0.05/);
    });

    it('counts every provider request a call made (retries)', async () => {
      const store = await makeStore();
      const r = request({ global: { maxCalls: 4 } });
      await (await store.reserve(r)).settle({ amount: 0, source: 'reported' }, 3); // 3 slots used
      await store.reserve(r); // 4th
      await expect(store.reserve(r)).rejects.toBeInstanceOf(DecisionUnavailableError);
    });

    it('is atomic: concurrent reservations cannot overshoot the cap', async () => {
      const store = await makeStore();
      const r = request({ global: { maxCalls: 5 } });
      const results = await Promise.allSettled(Array.from({ length: 25 }, () => store.reserve(r)));
      expect(results.filter((x) => x.status === 'fulfilled').length).toBe(5);
    });

    it('lets calls through again once the window has passed', async () => {
      const store = await makeStore();
      const r = request({ windowMs: 300, global: { maxCalls: 1 } });
      await store.reserve(r);
      await expect(store.reserve(r)).rejects.toBeInstanceOf(DecisionUnavailableError);
      await sleep(450);
      await expect(store.reserve(r)).resolves.toBeDefined();
    });
  });
}
