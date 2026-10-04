# Production adapters

By default the budget, the review queue and the cache live in the memory of one process. That is
fine on a laptop and in tests. In production, where an app runs as several instances that restart
from time to time, it goes wrong in three different ways:

| In memory | What goes wrong | Adapter |
|---|---|---|
| **Budget** | Each instance counts its own calls, so `maxCalls: 600` across 5 instances is really 3,000. The cap looks safe and isn't. | `RedisBudgetStore` |
| **Review queue** | A restart loses every request waiting for a human. The customer was told "pending review" and nobody ever sees it. | `BullReviewQueue` |
| **Cache** | Every instance pays for the same call once. Costs money, not safety. | `RedisDecisionCache` |

In production the library logs a warning at startup when the default review queue is active or a
budget is set without a shared store. Fix the warning; do not silence it.

All adapters take a client **you** create, so you keep control of the connection, TLS, retries and
cluster setup. They have no runtime dependency on Redis libraries. Any `ioredis` client works.

## Shared budget: `@nest-decisions/redis`

```ts
import Redis from 'ioredis';
import { RedisBudgetStore } from '@nest-decisions/redis';

const redis = new Redis(process.env.REDIS_URL);

DecisionsModule.forRoot({
  provider,
  budget: {
    maxCalls: 600,                 // 600 across ALL instances per window
    windowMs: 60_000,
    perKey: { maxCalls: 60 },      // per tenant, with Decision.budgetKey
    store: new RedisBudgetStore({ client: redis }),
  },
});
```

- **One limit for the fleet.** The check and the slot are taken in a single atomic Redis script,
  so concurrent calls from many instances cannot overshoot the cap. This is tested with real Redis
  and several clients racing for the same budget.
- **Redis's clock, not yours.** The script reads the time from Redis, so instances with skewed
  clocks agree on the window.
- **Self-cleaning.** Counters expire on their own.
- **Same behavior as the in-memory store.** It passes the shared contract suite
  (`budgetStoreContract` from `@nest-decisions/testing`): caps calls and spend, per-key limits,
  counting every provider retry, counting calls that were never settled, and window expiry.
- **If Redis is down, calls are refused** (fail closed), as `DecisionUnavailableError`, so a
  decision with a `fallback` degrades and one without answers 503. If you would rather keep the app
  up and lose the cap during an outage, pass `failOpen: true`. That is a deliberate trade-off:
  there is then no limit.
- **Redis Cluster:** the default prefix `{nest-decisions}:budget` contains a hash tag so the global
  and per-key sets share a slot, which the script needs. Keep a `{...}` in a custom `prefix`.

The script scans the window's entries, so cost grows with the number of calls inside the window.
Keep windows to minutes, not days.

## Shared cache: `@nest-decisions/redis`

```ts
import { RedisDecisionCache } from '@nest-decisions/redis';

DecisionsModule.forRoot({
  provider,
  hashSecret: process.env.DECISIONS_HASH_SECRET,
  cache: new RedisDecisionCache({ client: redis, ttlMs: 60_000 }),
});
```

- Entries hold **answers, model and cost only**. Never the request or the state.
- Keys are hashes of the state. Set `hashSecret` so the keys cannot be reversed by guessing a
  low-entropy value such as an email, because the keys are visible in Redis.
- A Redis outage is a **cache miss**, never a failed decision, and a corrupt entry is a miss too.
- The core also re-validates every cached answer, so a store that returned `null` for a probability
  cannot reach a policy.

## Durable review queue: `@nest-decisions/bullmq`

```ts
import { Queue } from 'bullmq';
import { BullReviewQueue } from '@nest-decisions/bullmq';

const reviews = new Queue('reviews', { connection: { host, port } });

DecisionsModule.forRoot({
  provider,
  reviewQueue: new BullReviewQueue({ queue: reviews }),
});
```

A request a gate holds for a human becomes a BullMQ job in Redis, so it survives restarts and is
shared by every instance. The `reviewId` in the 202 body is the job id.

Each job's data is `{ decision, payload, reason, queuedAt }`. `payload` is the **redacted state the
model saw** (or what the gate's `reviewPayload` returned), not the raw request.

These jobs are not meant to be processed automatically. They wait until a person decides. A
reviewer tool or service lists them and removes each one once handled:

```ts
const waiting = await reviews.getJobs(['waiting']);           // what needs a human
const job = await reviews.getJob(reviewId);                   // one item, from the 202 body
// ... a person approves or rejects, your code applies the outcome ...
await job?.remove();
```

If Redis cannot take the job, the gate answers **503**: a request nobody can review is never let
through.

Set retention with BullMQ job options, for example
`new BullReviewQueue({ queue, jobOptions: { removeOnComplete: { age: 7 * 24 * 3600 } } })`.

## Writing your own

The interfaces are small:

```ts
interface BudgetStore { reserve(request: BudgetReserveRequest): Promise<BudgetReservation> }
interface DecisionCache { get(key): CachedResult | undefined | Promise<...>; set(key, value): void | Promise<void> }
interface ReviewQueue { enqueue(item: ReviewItem): Promise<{ id: string }> }
```

Run your budget store through the shared contract so it behaves like the others:

```ts
import { budgetStoreContract } from '@nest-decisions/testing';
budgetStoreContract({ describe, it, expect }, 'MyStore', () => new MyStore({ prefix: unique() }));
```

`reserve` must be atomic: check the limits and take the slot in one step.

## Testing against a real Redis

The adapter tests run against a real Redis when `REDIS_URL` is set and skip otherwise. Use a
throwaway database: `REDIS_URL=redis://localhost:6379/15`. Every test uses a unique key prefix and
deletes only its own keys.
