---
'@nest-decisions/core': minor
'@nest-decisions/testing': minor
'@nest-decisions/provider-jev': minor
'@nest-decisions/redis': minor
'@nest-decisions/bullmq': minor
---

First alpha: `Decision` base class and `DecisionsModule`, typed `noul`/`choice`/`score` questions, `@Gate` with allow/review/block verdicts, `DecisionRouter`, shadow mode, cache, budget guard, review queue, audit and calibration helpers, a deterministic testing provider, and the Jev (TypeSafe System One) provider. Production adapters: a Redis budget store and cache shared across instances, and a durable BullMQ review queue.
