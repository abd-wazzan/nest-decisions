import {
  type AnswersOf,
  Decision,
  DecisionsModule,
  DecisionUnavailableError,
  noul,
} from '@nest-decisions/core';
import { budgetStoreContract } from '@nest-decisions/testing';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { RedisBudgetStore, type RedisLike } from '../src';
import { connect, deleteByPrefix, REDIS_URL, uniquePrefix } from './helpers';

const run = describe.skipIf(!REDIS_URL);

run('RedisBudgetStore (real Redis)', () => {
  const clients: ReturnType<typeof connect>[] = [];
  const prefixes: string[] = [];
  const newClient = () => {
    const c = connect();
    clients.push(c);
    return c;
  };
  const newPrefix = () => {
    const p = `${uniquePrefix()}:budget`;
    prefixes.push(p);
    return p;
  };

  afterAll(async () => {
    const [cleaner] = clients.length ? clients : [newClient()];
    for (const p of prefixes)
      await deleteByPrefix(cleaner as ReturnType<typeof connect>, p.split(':')[0] as string);
    await Promise.all(clients.map((c) => c.quit()));
  });

  // Every contract case gets a store with its own empty counters.
  budgetStoreContract({ describe, it, expect } as never, 'RedisBudgetStore', () => {
    return new RedisBudgetStore({ client: newClient(), prefix: newPrefix() });
  });

  it('is shared across instances: two stores on one prefix enforce one limit', async () => {
    const prefix = newPrefix();
    const a = new RedisBudgetStore({ client: newClient(), prefix });
    const b = new RedisBudgetStore({ client: newClient(), prefix });
    const request = { windowMs: 60_000, global: { maxCalls: 3 } };
    await a.reserve(request);
    await b.reserve(request);
    await a.reserve(request);
    await expect(b.reserve(request)).rejects.toBeInstanceOf(DecisionUnavailableError);
    await expect(a.reserve(request)).rejects.toBeInstanceOf(DecisionUnavailableError);
  });

  it('is atomic across instances under concurrency', async () => {
    const prefix = newPrefix();
    const stores = Array.from(
      { length: 4 },
      () => new RedisBudgetStore({ client: newClient(), prefix }),
    );
    const request = { windowMs: 60_000, global: { maxCalls: 8 } };
    const results = await Promise.allSettled(
      Array.from({ length: 40 }, (_, i) => (stores[i % 4] as RedisBudgetStore).reserve(request)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(8);
  });

  it('sets an expiry on its keys so they clean themselves up', async () => {
    const prefix = newPrefix();
    const client = newClient();
    await new RedisBudgetStore({ client, prefix }).reserve({
      windowMs: 5_000,
      global: { maxCalls: 5 },
    });
    const ttl = await client.pttl(`${prefix}:global`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10_000);
  });

  it('fails closed by default and open on request when Redis is unreachable', async () => {
    const broken: RedisLike = {
      eval: async () => {
        throw new Error('ECONNREFUSED');
      },
      get: async () => null,
      set: async () => 'OK',
    };
    const request = { windowMs: 60_000, global: { maxCalls: 1 } };
    await expect(new RedisBudgetStore({ client: broken }).reserve(request)).rejects.toThrow(
      'ECONNREFUSED',
    );
    const open = await new RedisBudgetStore({ client: broken, failOpen: true }).reserve(request);
    await expect(Promise.resolve(open.settle())).resolves.toBeUndefined();
  });

  it('works as the budget store of a real decision, shared by two app instances', async () => {
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
    const prefix = newPrefix();
    const build = async () => {
      let calls = 0;
      const provider = {
        name: 'p',
        calls: () => calls,
        evaluate: async () => {
          calls++;
          return {
            answers: { bad: { type: 'noul' as const, noul: 0.9 } },
            model: 'm',
            cost: { amount: 0, source: 'mock' as const },
          };
        },
      };
      const mod = await Test.createTestingModule({
        imports: [
          DecisionsModule.forRoot({
            provider,
            dedupe: false,
            audit: { record: () => {} },
            budget: { maxCalls: 2, store: new RedisBudgetStore({ client: newClient(), prefix }) },
          }),
        ],
        providers: [Check],
      }).compile();
      return { check: mod.get(Check), provider };
    };
    const one = await build();
    const two = await build();
    await one.check.decide({ text: 'a' });
    await two.check.decide({ text: 'b' });
    // Two instances, one budget of 2: the third call is refused on either of them.
    await expect(one.check.decide({ text: 'c' })).rejects.toBeInstanceOf(DecisionUnavailableError);
    await expect(two.check.decide({ text: 'd' })).rejects.toBeInstanceOf(DecisionUnavailableError);
    expect(one.provider.calls() + two.provider.calls()).toBe(2);
  });
});
