# @nest-decisions/redis

Redis-backed **budget store** and **cache** for `@nest-decisions/core`, shared by every instance.

```ts
import Redis from 'ioredis';
import { RedisBudgetStore, RedisDecisionCache } from '@nest-decisions/redis';

const client = new Redis(process.env.REDIS_URL);

DecisionsModule.forRoot({
  provider,
  hashSecret: process.env.DECISIONS_HASH_SECRET,
  budget: { maxCalls: 600, store: new RedisBudgetStore({ client }) },   // 600 across all instances
  cache: new RedisDecisionCache({ client, ttlMs: 60_000 }),
});
```

- The budget check and slot are one atomic Redis script, on Redis's own clock; it fails closed when
  Redis is down (`failOpen: true` to change that).
- The cache stores answers only, never state, and a Redis outage is a miss.
- Takes any `ioredis`-style client; no runtime dependency on a Redis library.

Full guide: [production adapters](https://github.com/abd-wazzan/nest-decisions/blob/main/docs/adapters.md).

Status: pre-alpha. MIT.
