# Production checklist

Work through this before a decision touches real traffic.

## Decide what is allowed to be wrong

- [ ] **A decision is never your only control.** Authorization, arithmetic, limits and dates stay
      in code. Gates are an additional signal.
- [ ] **Every decision has a failure plan.** Add `fallback()` where degrading is acceptable (usually
      "send to a human"). Leave it out where failing closed is right. A gate refuses a fallback
      `allow` unless you set `allowOnFallback`.
- [ ] **Consequences set the thresholds.** Reading a ticket tolerates a low bar. Moving money does not.

## Data

- [ ] **`state()` sends the minimum.** No ids, emails or secrets the question does not need. Facts
      come from your data, not the caller.
- [ ] **State leaves your infrastructure.** Confirm your provider's data handling with them, and
      check it against your own privacy obligations. This library cannot verify it for you.
- [ ] **Add a `redact` hook** if state can contain personal data: `DecisionsModule.forRoot({ redact })`.
- [ ] **Set `hashSecret`.** Audit and cache hashes are plain SHA-256 otherwise, which can be reversed
      by guessing when the state is an email or phone number.
- [ ] **Audit records never contain state** (only a hash), but `result.raw` returned from
      `decide()` does hold the request and response. Do not log it blindly.

## Operations

- [ ] **Credentials from your config service.** A missing key throws at startup, by design.
- [ ] **Set `timeoutMs`** to what your endpoint can afford (default 30000 is generous).
- [ ] **Set a budget** (`maxCalls`, and `maxUsd` if your provider reports cost) to cap a bug or an attack.
      Add `perKey` and `Decision.budgetKey` if tenants share the module, so one cannot starve the rest.
- [ ] **Use a real `AuditSink`.** The default logs one line per decision. Keep outcomes
      (`decided`, `fallback`, `error`, `gated`) somewhere you can query. `error` covers an
      unavailable decision with no fallback and a `policy()` that threw, so a paid call is never invisible.
- [ ] **Use a real `ReviewQueue`.** The in-memory default holds 1000 items and loses them on restart.
      `BullReviewQueue` from `@nest-decisions/bullmq` is durable ([adapters](./adapters.md)).
- [ ] **Use a shared cache** if you run several instances: `RedisDecisionCache`, or implement
      `DecisionCache` (sync or async). Set `hashSecret`, because cache keys are visible in Redis.
- [ ] **Use a shared budget** if you run several instances: `RedisBudgetStore`. Per-process counters
      multiply your limit by the number of instances.
- [ ] **Global exception filters must pass `DecisionReviewRequiredException` through.** A filter
      that wraps every error hides the `reviewId`, so clients cannot follow up.
- [ ] **Startup warnings are real.** In production the library warns when the default in-memory
      review queue is active and when budgets are per process. Fix them; do not silence them.
- [ ] **Run the live contract test on a schedule** (`JEV_LIVE=1`, see the provider README), so a
      change in the provider's wire format is caught by you and not by users.
- [ ] **Watch the fallback rate and the review rate.** A rise in either is the early signal that the
      provider, the model or your traffic changed.

## Quality

- [ ] **Calibrate on your own labelled cases** ([calibration](./calibration.md)). Re-run when you
      change a question or when the model version changes.
- [ ] **Put your rules in the question criteria**, not only in thresholds.
- [ ] **Roll out in shadow mode first** and read the disagreements.
- [ ] **Pin the model** (`model` option) once you have calibrated, and re-calibrate before moving it.
      `jev-latest` is a moving alias.

## Testing and tooling

- [ ] Unit-test each `policy()` as a pure function, and each decision with `DecisionsTestingModule`.
- [ ] Assert what you send: `provider.calls[0].state` should not contain what it must not.
- [ ] **Vitest and decorators:** the library's classes use explicit `@Inject(...)`. If your own
      decisions take constructor dependencies by type, Vitest's default transform does not emit
      decorator metadata, so use an SWC plugin or inject explicitly.
- [ ] **`noImplicitOverride`:** subclasses must write `override fallback()`.

## Known limits

- The injection gate is a signal, not a guarantee (see [calibration](./calibration.md)).
- Both formats of each package share one copy of every class (the ESM entry re-exports the CJS
  build), so Nest injection tokens and `instanceof` checks agree however a package is imported.
- Review queue, cache and budget default to in-memory. Production needs the adapters in
  [adapters](./adapters.md) (Redis, BullMQ) or your own implementation of the same interfaces.
