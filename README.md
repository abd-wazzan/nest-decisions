# nest-decisions

Decision-first building blocks for NestJS: confidence-gated actions with shadow rollout. Replace brittle `if`/regex/keyword logic with typed,
confidence-aware decisions: ask a bounded question, get a probability, and let confidence choose
the code path (auto, review, or reject).

> Status: pre-alpha. Core (`Decision`, `DecisionsModule`, typed questions, fallback, audit,
> redaction, shadow mode, `@Gate` guard/gated actions with review queue, router, cache, budget),
> the testing kit and the Jev provider work today. See [PLAN.md](./PLAN.md).

## Packages

| Package | Purpose | Status |
|---|---|---|
| `@nest-decisions/core` | `Decision` base class, `DecisionsModule`, typed questions, fallback, audit, redaction, `shadowRun` | pre-alpha |
| `@nest-decisions/testing` | Deterministic mock provider and test helpers | pre-alpha |
| `@nest-decisions/redis` | Shared budget store and cache on Redis | pre-alpha |
| `@nest-decisions/bullmq` | Durable review queue on BullMQ | pre-alpha |
| `@nest-decisions/provider-jev` | TypeSafe System One (Jev) provider, direct or via OpenRouter | pre-alpha |

## Provider support

The core talks to models through one small interface (`DecisionProvider`), so a provider is a
small package. Today there is **one real provider**, for TypeSafe's Jev (System One) model, and a
deterministic mock for tests. There is no generic "any LLM" provider on purpose: the value here is
calibrated probabilities, and a chat model's self-reported probabilities are not calibrated. See
[writing a provider](./docs/writing-a-provider.md) if you want to add one.

TypeSafe publishes its own SDK (`@typesafe-ai/sdk`). This repository's Jev provider is a separate,
dependency-free client with strict response validation, one retry policy, and no redirect
following; the SDK is a fine choice if you only need the model and not the decision layer.

## Docs

Documentation site: https://abd-wazzan.github.io/nest-decisions/ (once GitHub Pages is enabled).
The pages are in [`docs/`](./docs); run them locally with `pnpm docs:dev`.

- [Why decisions](./docs/why-decisions.md): the mindset
- [Quickstart](./docs/quickstart.md)
- [Concepts](./docs/concepts.md): question types, state, confidence
- [Recipes](./docs/recipes.md)
- [Calibration](./docs/calibration.md): measure before you trust a threshold
- [Production adapters](./docs/adapters.md): Redis budget and cache, BullMQ review queue
- [Production checklist](./docs/production-checklist.md)
- [Trying it with real teams](./docs/testing-with-users.md): a session script for early testers
- [Writing a provider](./docs/writing-a-provider.md)

## Example

See [`examples/support-desk`](./examples/support-desk), a runnable Nest app (works with no API key): ticket triage (urgency, frustration and
topic in one call), a prompt-injection gate, and an auto/review/block refund gate, each with its
policy and tests.

## Development

```bash
pnpm install
pnpm verify   # lint, typecheck, test, build, and an ESM/CJS identity check
```

Requires Node >= 20.19 and pnpm 12.

## Releasing

Versioned with Changesets and staged on npm by GitHub Actions with provenance; a maintainer approves each release with 2FA. See [docs/releasing.md](./docs/releasing.md).

## License

MIT

---

Thanks to [disler](https://github.com/disler) for the inspiring video [10 Levels of Jev for Agentic Engineers](https://youtu.be/_U-O5lYhJ7Q).
