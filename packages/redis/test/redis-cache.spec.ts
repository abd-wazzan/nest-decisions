import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisDecisionCache, type RedisLike } from '../src';
import { connect, deleteByPrefix, REDIS_URL, uniquePrefix } from './helpers';

const result = {
  answers: { a: { type: 'noul' as const, noul: 0.7 } },
  model: 'm',
  cost: { amount: 0.01, source: 'reported' as const },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('RedisDecisionCache (unit)', () => {
  it('rejects a bad ttl', () => {
    expect(() => new RedisDecisionCache({ client: {} as RedisLike, ttlMs: 0 })).toThrow(/ttlMs/);
  });

  it('treats an unreachable Redis as a miss and never throws', async () => {
    const down: RedisLike = {
      eval: async () => 0,
      get: async () => {
        throw new Error('ECONNREFUSED');
      },
      set: async () => {
        throw new Error('ECONNREFUSED');
      },
    };
    const cache = new RedisDecisionCache({ client: down, ttlMs: 1000 });
    await expect(cache.get('k')).resolves.toBeUndefined();
    await expect(cache.set('k', result)).resolves.toBeUndefined();
  });

  it('treats a corrupt entry as a miss', async () => {
    const corrupt: RedisLike = {
      eval: async () => 0,
      get: async () => '{not json',
      set: async () => 'OK',
    };
    await expect(
      new RedisDecisionCache({ client: corrupt, ttlMs: 1000 }).get('k'),
    ).resolves.toBeUndefined();
  });
});

describe.skipIf(!REDIS_URL)('RedisDecisionCache (real Redis)', () => {
  let client: Redis;
  const extra: Redis[] = [];
  const prefix = `${uniquePrefix()}:cache:`;
  beforeAll(() => {
    client = connect();
  });
  afterAll(async () => {
    await deleteByPrefix(client, prefix.split(':')[0] as string);
    await Promise.all([client, ...extra].map((c) => c.quit()));
  });

  it('round-trips answers and is shared between cache instances', async () => {
    const a = new RedisDecisionCache({ client, ttlMs: 5_000, prefix });
    const other = connect();
    extra.push(other);
    const b = new RedisDecisionCache({ client: other, ttlMs: 5_000, prefix });
    expect(await a.get('k1')).toBeUndefined();
    await a.set('k1', result);
    expect(await b.get('k1')).toEqual(result);
  });

  it('expires entries after the ttl', async () => {
    const cache = new RedisDecisionCache({ client, ttlMs: 150, prefix });
    await cache.set('short', result);
    expect(await cache.get('short')).toEqual(result);
    await sleep(300);
    expect(await cache.get('short')).toBeUndefined();
  });

  it('stores answers only: no state and no raw payloads', async () => {
    const cache = new RedisDecisionCache({ client, ttlMs: 5_000, prefix });
    await cache.set('safe', result);
    const stored = (await client.get(`${prefix}safe`)) as string;
    expect(Object.keys(JSON.parse(stored)).sort()).toEqual(['answers', 'cost', 'model']);
  });
});
