# @nest-decisions/provider-jev

Provider for TypeSafe's System One model (Jev), direct or through OpenRouter.

```ts
new JevProvider({ backend: 'typesafe', apiKey: config.getOrThrow('TYPESAFE_API_KEY') });
```

- Backend and credentials are fixed at construction; missing credentials throw at startup, and the
  provider never switches backend after a failure.
- Retries 429, 502, 503 and 529, and transport failures (connection reset, DNS, TLS), with
  backoff and jitter. A `Retry-After` longer than `maxRetryWaitMs` (default 8s) fails immediately.
  401 and 422 are not retried, and a caller abort is never retried.
- Redirects are refused, never followed, so the bearer token cannot be forwarded to another host.
- Strict validation of every response against the questions asked.
- Cost is `reported`, `estimated` (from `pricing` you supply) or `unknown`. TypeSafe does not currently
  report cost.
- The API key is held in a private field, so it does not appear when the provider is logged or serialized.
- The OpenRouter endpoint is unverified against current documentation; confirm it before relying on it.

## Live contract test

`test/live-contract.spec.ts` calls the real API with a handful of tiny requests and checks that the
wire format still matches what this provider validates. It is skipped unless you opt in:

```bash
JEV_LIVE=1 TYPESAFE_API_KEY=... pnpm --filter @nest-decisions/provider-jev test
```

Run it on a schedule, and after any API or SDK release.

## Why not the official SDK?

TypeSafe publishes `@typesafe-ai/sdk`. This provider is a separate client so that the decision layer
owns validation, retry, abort and redirect behavior and has no runtime dependencies. If you only
need the model and not the decision layer, the official SDK is a fine choice.

Status: pre-alpha. MIT.
