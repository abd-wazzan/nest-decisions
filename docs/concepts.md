# Concepts

## The three question types

| Type | You ask | You get | Use it for |
|---|---|---|---|
| `noul` | a yes/no question, with optional descriptions of what yes and no mean | the probability of yes, 0 to 1 | gates, flags, "is this X" |
| `choice` | pick exactly one of up to 255 options you define | the picked option, a probability for every option, a `confidence` | classification, routing |
| `score` | a position on 2 to 10 ordered levels you describe | a score that can land between levels, probabilities, a `confidence` | grading, severity, sentiment |

```ts
import { choice, noul, score } from '@nest-decisions/core';

const questions = {
  urgent: noul('Does the customer report an outage, data loss or money lost right now?'),
  topic: choice('What is this ticket mainly about?', { billing: null, bug: null, access: null }),
  frustration: score('How frustrated is the customer?', ['calm', 'annoyed', 'angry', 'furious']),
};
```

A `choice` answer is always one of your options, and its type is the exact union of your option ids,
so `a.topic.choice` is `'billing' | 'bug' | 'access'` in your policy.

## Ask independent questions together

Questions on the same state run in **one request**, in parallel, and cannot see each other. Ask
everything you might need at once (the triage example asks three) and let the policy pick which
answers matter. Make a second request only when you need an earlier answer to build the next state.

## State: send the minimum

The model only judges what you send. `state()` is required on every decision, and nothing is sent
by default.

- Send the fields the question needs. Not the whole DTO.
- Never send ids, emails or secrets the question does not need.
- Load facts from your own data, not from the caller. A refund gate should take `orderStatus` from
  your orders service, not from the request body.
- Use named object fields when the context has several parts: `{ reason, orderStatus }`.

## Put your rules in the question

A decision is only as good as the question. If your policy is "refunds are for defective, wrong or
undelivered items, not change of mind", **say so in the criteria**. In our calibration run this
single change moved refund classification from overlapping scores to clean separation (see
[calibration](./calibration.md)).

```ts
noul('Does the customer reason describe a product or delivery problem that entitles them to a refund?', {
  true: 'A defective, damaged, wrong or missing item, an order that never arrived, a duplicate charge...',
  false: 'Change of mind, buyer remorse, a better price elsewhere, an item used and no longer wanted...',
})
```

Give open-ended `choice` questions an `other` option so the model has somewhere to go when nothing fits.

## Reading confidence

- A **noul** near 0.5 means the model is unsure, not "medium". Treat it as uncertainty.
- **Choice and score confidence** describes how concentrated the distribution is. It is not a
  guarantee the answer is right, and not permission to act. Several acceptable options can spread
  the probability, so a low confidence on a harmless preference does not need escalating.
- Scale thresholds with consequences. Reading a ticket tolerates a lower bar than refunding money.

## Verdicts and gates

A gate decision returns `allow`, `review` or `block`. Two helpers turn a probability into a verdict
so the thresholds live in your policy:

```ts
verdictFromRisk(p, { blockAbove: 0.8, reviewAbove: 0.3 });   // for "bad thing" probabilities
verdictFromTrust(p, { allowAbove: 0.8, reviewAbove: 0.2 });  // for "legitimate" probabilities
```

`@Gate` applies the verdict: `allow` runs the handler, `review` queues it and answers 202,
`block` answers 403, and a decision that cannot be made answers 503 (see below for fallbacks).

## Fallbacks and failing closed

A decision **without** a `fallback()` throws `DecisionUnavailableError` when the provider is down,
times out, returns something malformed, or the budget is exhausted. A gate turns that into a 503,
so the request does not run. This is the fail-closed default.

A decision **with** a `fallback()` returns your safe default instead (usually "send to a human").
Use it where degrading is better than failing. Validation errors (bad questions or state) always
throw, because they are bugs, not outages.

Fallbacks and gates interact, so a gate adds its own guard:

- A fallback verdict of `review` or `block` is honored.
- A fallback verdict of **`allow` is refused with a 503** unless the gate sets
  `allowOnFallback: true`. Running a protected handler because the safety check was down is almost
  never what you want, so you must ask for it explicitly.
- A policy that returns something that is not a valid verdict (`null`, `'maybe'`) also answers 503
  and is recorded in the audit log.

## What a review response looks like

A `review` verdict does not run the handler. The gate throws
`DecisionReviewRequiredException`, which answers **HTTP 202** with the stable body
`{ "status": "pending_review", "reviewId": "..." }`. 202 means accepted, not completed: a client
must read the body, and must not treat the 2xx as "the refund happened".

- Change the status with `@Gate({ reviewStatus: 409 })` if your clients need a non-2xx.
- **A global exception filter must let `DecisionReviewRequiredException` through unchanged**
  (`if (exception instanceof DecisionReviewRequiredException) ...`). A filter that wraps every
  error in its own envelope will keep the 202 but replace the body, so clients lose the
  `reviewId`. The test suite shows both versions.
- On microservices or websockets, Nest turns an `HttpException` into a generic internal error, so
  pass `exceptionFactory` to return an `RpcException` or `WsException` for each outcome
  (`review`, `block`, `unavailable`). HTTP and GraphQL work with the defaults.
