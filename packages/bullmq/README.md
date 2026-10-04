# @nest-decisions/bullmq

A durable **review queue** for `@nest-decisions/core` on BullMQ. A request a gate holds for a human
becomes a job in Redis, so it survives restarts and is shared by every instance.

```ts
import { Queue } from 'bullmq';
import { BullReviewQueue } from '@nest-decisions/bullmq';

DecisionsModule.forRoot({
  provider,
  reviewQueue: new BullReviewQueue({ queue: new Queue('reviews', { connection }) }),
});
```

- The `reviewId` in the 202 response is the job id. Job data is
  `{ decision, payload, reason, queuedAt }`, where `payload` is the redacted state the model saw.
- Jobs wait for a person; a reviewer tool lists them (`queue.getJobs(['waiting'])`) and removes each
  once handled.
- If Redis cannot take the job, the gate answers 503: a request nobody can review is never let through.

Full guide: [production adapters](https://github.com/abd-wazzan/nest-decisions/blob/main/docs/adapters.md).

Status: pre-alpha. MIT.
