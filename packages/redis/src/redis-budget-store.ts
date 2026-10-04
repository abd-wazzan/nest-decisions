import { randomUUID } from 'node:crypto';
import {
  type BudgetReservation,
  type BudgetReserveRequest,
  type BudgetStore,
  throwIfOver,
} from '@nest-decisions/core';
import type { RedisLike } from './redis-client.js';

export interface RedisBudgetStoreOptions {
  client: RedisLike;
  /**
   * Prefix for every key. Include a hash tag, as the default does, so the global and per-key sets
   * land in the same slot on Redis Cluster (the script touches both at once). Default `{nest-decisions}:budget`.
   */
  prefix?: string;
  /**
   * What to do when Redis is unreachable. `false` (default) fails closed: the call is refused as
   * unavailable. `true` lets calls through uncounted, which keeps the app up but removes the cap.
   */
  failOpen?: boolean;
}

// Sliding window kept in two sorted sets (global, and one per key). A member is "<id>|<usd>" with
// the reservation time as its score. The script uses Redis's own clock, so servers with skewed
// clocks agree, and it checks the limits and takes the slot in one atomic step.
//   ARGV: windowMs, id, gMaxCalls, gMaxUsd, kMaxCalls, kMaxUsd, hasKey   (-1 means no limit)
//   returns 0 = reserved, 1/2 = global calls/usd exceeded, 3/4 = key calls/usd exceeded
const RESERVE = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local window = tonumber(ARGV[1])
local id = ARGV[2]
local hasKey = ARGV[7] == '1'

local function stats(key)
  redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
  local members = redis.call('ZRANGE', key, 0, -1)
  local usd = 0
  for _, m in ipairs(members) do
    local sep = string.find(m, '|', 1, true)
    usd = usd + tonumber(string.sub(m, sep + 1))
  end
  return #members, usd
end

local gCalls, gUsd = stats(KEYS[1])
local gMaxCalls, gMaxUsd = tonumber(ARGV[3]), tonumber(ARGV[4])
if gMaxCalls >= 0 and gCalls >= gMaxCalls then return 1 end
if gMaxUsd >= 0 and gUsd >= gMaxUsd then return 2 end

if hasKey then
  local kCalls, kUsd = stats(KEYS[2])
  local kMaxCalls, kMaxUsd = tonumber(ARGV[5]), tonumber(ARGV[6])
  if kMaxCalls >= 0 and kCalls >= kMaxCalls then return 3 end
  if kMaxUsd >= 0 and kUsd >= kMaxUsd then return 4 end
  redis.call('ZADD', KEYS[2], now, id .. '|0')
  redis.call('PEXPIRE', KEYS[2], window * 2)
end
redis.call('ZADD', KEYS[1], now, id .. '|0')
redis.call('PEXPIRE', KEYS[1], window * 2)
return 0
`;

// Records what a reservation turned out to cost and how many requests it made.
//   ARGV: id, usd, attempts, hasKey
const SETTLE = `
local id, usd, attempts = ARGV[1], ARGV[2], tonumber(ARGV[3])
local function settle(key)
  local score = redis.call('ZSCORE', key, id .. '|0')
  if not score then return end -- already slid out of the window
  redis.call('ZREM', key, id .. '|0')
  redis.call('ZADD', key, score, id .. '|' .. usd)
  for i = 2, attempts do
    redis.call('ZADD', key, score, id .. '#' .. i .. '|0')
  end
end
settle(KEYS[1])
if ARGV[4] == '1' then settle(KEYS[2]) end
return 1
`;

const num = (n: number | undefined) => (n === undefined ? -1 : n);

/**
 * A budget shared by every instance of your app, so `maxCalls: 600` means 600 across the fleet and
 * not 600 per server. Counters live in Redis and expire on their own.
 *
 *   DecisionsModule.forRoot({ provider, budget: { maxCalls: 600, store: new RedisBudgetStore({ client }) } })
 */
export class RedisBudgetStore implements BudgetStore {
  private readonly client: RedisLike;
  private readonly prefix: string;
  private readonly failOpen: boolean;

  constructor(options: RedisBudgetStoreOptions) {
    this.client = options.client;
    this.prefix = options.prefix ?? '{nest-decisions}:budget';
    this.failOpen = options.failOpen ?? false;
  }

  async reserve(request: BudgetReserveRequest): Promise<BudgetReservation> {
    const globalKey = `${this.prefix}:global`;
    const key = request.key;
    const keyed = key !== undefined && request.perKey !== undefined;
    const id = randomUUID().replaceAll('-', '');
    const keys = keyed ? [globalKey, `${this.prefix}:key:${key}`] : [globalKey];
    const perKey = request.perKey ?? {};

    let code: unknown;
    try {
      code = await this.client.eval(
        RESERVE,
        keys.length,
        ...keys,
        request.windowMs,
        id,
        num(request.global.maxCalls),
        num(request.global.maxUsd),
        num(perKey.maxCalls),
        num(perKey.maxUsd),
        keyed ? 1 : 0,
      );
    } catch (error) {
      if (this.failOpen) return { settle: () => {} };
      throw error; // the service turns this into "unavailable": the call is refused
    }

    // Reproduce the exact error the in-memory store would raise.
    const w = request.windowMs;
    if (code === 1) throwIfOver(Infinity, 0, { maxCalls: request.global.maxCalls }, 'global', w);
    if (code === 2) throwIfOver(0, Infinity, { maxUsd: request.global.maxUsd }, 'global', w);
    if (code === 3) throwIfOver(Infinity, 0, { maxCalls: perKey.maxCalls }, `key "${key}"`, w);
    if (code === 4) throwIfOver(0, Infinity, { maxUsd: perKey.maxUsd }, `key "${key}"`, w);

    return {
      settle: async (cost, attempts = 1) => {
        await this.client.eval(
          SETTLE,
          keys.length,
          ...keys,
          id,
          cost?.amount ?? 0,
          attempts,
          keyed ? 1 : 0,
        );
      },
    };
  }
}
