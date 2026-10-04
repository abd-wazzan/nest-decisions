import type { CachedResult, DecisionCache } from '@nest-decisions/core';
import type { RedisLike } from './redis-client.js';

export interface RedisDecisionCacheOptions {
  client: RedisLike;
  /** How long an entry stays valid. */
  ttlMs: number;
  /** Prefix for every key. Default `nest-decisions:cache:`. */
  prefix?: string;
}

/**
 * Cache shared by every instance of your app. Entries hold answers, model and cost only, never the
 * request or the state. Keys are hashes of the state, so set `hashSecret` on the module if the
 * state can be low-entropy (an email, a phone number): the keys are visible in Redis.
 *
 * A Redis outage is a cache miss, never a failed decision.
 */
export class RedisDecisionCache implements DecisionCache {
  private readonly client: RedisLike;
  private readonly ttlMs: number;
  private readonly prefix: string;

  constructor(options: RedisDecisionCacheOptions) {
    if (!(options.ttlMs > 0)) throw new Error('ttlMs must be positive.');
    this.client = options.client;
    this.ttlMs = options.ttlMs;
    this.prefix = options.prefix ?? 'nest-decisions:cache:';
  }

  async get(key: string): Promise<CachedResult | undefined> {
    try {
      const raw = await this.client.get(this.prefix + key);
      return raw ? (JSON.parse(raw) as CachedResult) : undefined;
    } catch {
      return undefined; // unreachable Redis or a corrupt entry: treated as a miss
    }
  }

  async set(key: string, value: CachedResult): Promise<void> {
    try {
      await this.client.set(this.prefix + key, JSON.stringify(value), 'PX', this.ttlMs);
    } catch {
      // A failed write only costs a future provider call.
    }
  }
}
