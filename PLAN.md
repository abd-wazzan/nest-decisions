# nest-decisions: Build Plan

A NestJS toolkit, with a provider-neutral core, for **decision-first backends**: replace brittle `if`/regex/keyword logic with typed, confidence-aware decisions, with Jev (TypeSafe System One) as the recommended provider.

Owner: GitHub `abd-wazzan`; repo `github.com/abd-wazzan/nest-decisions`. License: MIT. Status: M0, M1 and the core of M2 done and independently reviewed (core, testing kit, `provider-jev`, `@Gate`, router, review queue, budget, cache, shadow runner, calibration helpers, docs). After two independent reviews and a debate, the order of work before any public announcement is: (1) get 3 to 5 real Nest teams to try one recipe in shadow mode, using the runnable demo in `examples/support-desk`; (2) production adapters in order of safety: a shared budget store, a durable review queue, then the cache (built: `@nest-decisions/redis` and `@nest-decisions/bullmq`, tested against real Redis); (3) docs site, `DecisionPipe`, interceptor, metrics and health. A generic LLM provider is deliberately not planned (see principle 6).

---

## 1. Vision and principles

**Mindset shift we teach:** wherever code guesses (is this urgent, which team, is this abusive, is this legit), ask a bounded question, get a probability, and let *confidence choose the code path*: auto, review, or reject.

Principles:
1. **Decisions, not completions.** Typed answers (yes/no probability, one-of-N, graded score), never prose to parse.
2. **Policy lives in code.** The model judges; a pure, unit-testable function decides.
3. **Fail closed, explicitly.** Every decision declares what happens on timeout, outage, or low confidence. No silent mock fallback in production.
4. **Auditable by default.** Every decision keeps its state hash, probabilities, model id, cost, outcome.
5. **Adopt without risk.** Shadow mode runs beside existing logic and logs disagreements without acting.
6. **Provider-neutral core, honest about providers.** Core depends on a `DecisionProvider` interface. Today there is one real provider; a generic LLM provider is deliberately not planned unless it can derive probabilities from token logprobs and declare how calibrated they are.
7. **Minimal state.** The developer chooses exactly what the model sees. No default of "send the whole body".

Non-goals: text generation, arithmetic, date logic, authorization (a gate is an extra signal, never the only control), self-hosting models.

---

## 2. Naming and distribution

- Public name: **`nest-decisions`** (free on npm at time of check; re-verify before first publish).
- Packages published as the scoped monorepo `@nest-decisions/*` if the org scope is claimable; otherwise `@abd-wazzan/nest-decisions-*`. Decide before first publish and re-check availability.
- Do not use `@nestjs/*` or names implying official Nest endorsement.
- Vendor names (Jev/TypeSafe) appear only in the provider package and docs, not in core API names. Contact TypeSafe about branding and an official provider listing in parallel (no blocker for v0).

---

## 3. Repository layout (pnpm + turborepo monorepo)

```
nest-decisions/
  packages/
    core/                  @nest-decisions/core
    testing/               @nest-decisions/testing
    provider-jev/          @nest-decisions/provider-jev
    provider-openrouter/   @nest-decisions/provider-openrouter   (v0.2)
    provider-llm/          @nest-decisions/provider-llm          (v0.3, generic structured-output LLM)
    audit-typeorm/         @nest-decisions/audit-typeorm         (v0.2)
    queue-bullmq/          @nest-decisions/queue-bullmq          (v0.2)
    cli/                   @nest-decisions/cli (schematics, init, tune)  (v0.3)
  examples/
    quickstart/            runs on the mock, no key
    support-desk/          triage + router + gated refunds
  docs/                    docs site (Docusaurus or Starlight)
  .changeset/ .github/ PLAN.md
```

Package rules: `@nestjs/common` and `@nestjs/core` as **peer deps** (`^10 || ^11 || ^12`), `reflect-metadata` peer, zero runtime deps in core, `"sideEffects": false`, `"files": ["dist"]`, `engines.node >=20.19`, dual ESM+CJS via `exports` map, `publishConfig.access: public`.

Tooling (learned from throttler and nestjs-pino): Vitest + `@vitest/coverage-v8`, Biome (or oxlint), husky + lint-staged + commitlint, changesets for versioning, renovate, CI matrix, npm provenance publishing from GitHub Actions (OIDC).

CI matrix: Node 20, 22, 24 × Nest 10, 11, 12 × Express and Fastify (e2e). Lint, typecheck, unit, e2e, build, `publint`, `arethetypeswrong`, size check.

---

## 4. Core architecture (`@nest-decisions/core`)

### 4.1 Provider contract

```ts
interface DecisionProvider {
  readonly name: string;
  evaluate(req: EvaluateRequest, opts?: CallOptions): Promise<EvaluateResult>;
}
// EvaluateRequest: { state, questions: Record<id, Noul|Choice|Score>, model? }
// EvaluateResult:  { answers, model, usage, cost: {amount|null, source}, raw: {request, response, text}, meta }
```

Answer types: `NoulAnswer {noul}`, `ChoiceAnswer {choice, probabilities, confidence}`, `ScoreAnswer {score, legend, probabilities, confidence}`.

### 4.2 Module

- `DecisionsModule.forRoot / forRootAsync`, built with `ConfigurableModuleBuilder` (supports `useFactory`, `useClass`, `useExisting`, `isGlobal`).
- Options: `provider`, `defaults` (timeout, retries), `fallback` (`allow | deny | review`), `audit`, `budget`, `redact`, `cache`, `shadow`.
- `DecisionsService` (low-level `evaluate`) is exported; most users never touch it.

### 4.3 Question builders (typed)

`noul(instructions, criteria?)`, `choice(instructions, options)`, `score(instructions, levels)`. Generics infer answer types so `policy()` is fully typed. Validation before sending (max 255 options, 2-10 score levels, non-empty instructions, request size cap).

### 4.4 `Decision` base class (the primary abstraction)

```ts
abstract class Decision<In, Out, Q extends Questions> {
  abstract questions: Q;
  abstract state(input: In): State | Promise<State>;      // explicit, minimal
  abstract policy(a: AnswersOf<Q>, input: In): Out;       // pure
  fallback?: FallbackPolicy<Out>;                         // per-decision override
  async decide(input: In): Promise<{ decision: Out; result: DecisionResult }>;
}
```

`@DecisionProvider()` registers it. `decide()` runs: redact → cache → budget check → provider call (retry/timeout) → policy → audit → shadow compare → return `{decision, result}`.

### 4.5 Integration surfaces (thin sugar over `Decision`)

| Surface | Name | Behavior |
|---|---|---|
| Guard | `@DecisionGuard(decisionClass, {block, review})` | Blocks, flags for review, or allows, using `ExecutionContext` (HTTP, GraphQL, RPC, WS) |
| Gated action | `@Gated({ decision, state, auto, review })` | Method runs only above `auto`; review path goes to `ReviewQueue`; below threshold throws `ForbiddenException` |
| Pipe | `JevPipe`-style `DecisionPipe` | Classifies or validates an incoming value |
| Interceptor | `DecisionInterceptor` | Annotates the response/request with the decision (non-blocking) |
| Router | `DecisionRouter` | Maps a `choice` to a handler, queue, or model with a low-confidence default |
| Consumer | `@RouteByDecision()` | For Kafka/Bull/Rabbit handlers (v0.2) |

Rules: decorators only set metadata, guards/interceptors read it (the throttler pattern). `state` is **required** in every surface; there is no implicit "send the body".

### 4.6 Cross-cutting services (interfaces in core, adapters elsewhere)

- **`FallbackPolicy`**: `allow | deny | review | custom(fn)`, per decision and global; applied on timeout, 5xx, budget exhaustion, malformed response.
- **`AuditSink`**: `record({decisionId, stateHash, questionsHash, answers, model, cost, outcome, durationMs, shadow})`; default `LoggerAuditSink`; `audit-typeorm` adds a table + migration helper. Never stores credentials or headers; optional full-state storage off by default.
- **`Redactor`**: hook run on state before sending and before auditing.
- **`ReviewQueue`**: `enqueue({decisionId, input, result})`; default in-memory; `queue-bullmq` adapter.
- **`BudgetGuard`**: per-decision, per-tenant (key function), and daily USD caps; `failMode: open|closed`.
- **`DecisionCache`**: key = hash(state + questions + model), TTL, pluggable store (memory default, `cache-manager` adapter).
- **`ShadowRunner`**: runs `decision.decide()` alongside a legacy function, logs agreement/disagreement, never alters the response.
- **Events** (`@nestjs/event-emitter` optional): `decision.completed`, `decision.fallback`, `decision.review`, `decision.budget_exceeded`; Prometheus metrics hook for latency, cost, confidence histogram, review rate.
- **Health**: `DecisionsHealthIndicator` for Terminus.

---

## 5. Providers

**`provider-jev` (v0.1):** direct TypeSafe endpoint (`/v1/systemone`) and OpenRouter alpha decisions endpoint. Port the proven client behavior: provider chosen once per instance (never switched on error), retries on 429/502/503/529 with exponential backoff + 20% jitter, total timeout including response body, redirects refused, key never logged or put in audit records, `raw` exchange retained, cost labeled `reported | estimated | unknown`, caller-supplied pricing for estimates, pinned model option. Missing credentials throw at startup (no silent mock).

**`testing` (v0.1):** `DecisionsTestingModule.with({ answers })` deterministic mock; `mockNoul(0.95)`, `mockChoice('billing', 0.9)`, `mockScore(2.7)`; `expectDecision` helpers; call recorder to assert what state was sent (catches PII leaks in tests). The mock tests wiring, not model accuracy, and the docs say so.

**Later providers:** OpenRouter standalone, generic LLM (any chat model with structured output, computes noul/choice/score via forced schema, logprobs when available), documented `DecisionProvider` guide for third parties.

---

## 6. Use-case library (the "real use cases, not one function" requirement)

Shipped as copy-paste **recipes** in `examples/` and docs, with a tested reference implementation each (class + spec + mock fixtures). v0.1 ships the first four.

| # | Recipe | Replaces | Shape |
|---|---|---|---|
| 1 | Injection/abuse gate | regex filters | `@DecisionGuard` |
| 2 | Support triage (category + urgent + frustration in one call) | keyword routing | `Decision` + policy |
| 3 | Confidence-gated refund/action (auto / review / reject) | hard-coded thresholds | `@Gated` + `ReviewQueue` |
| 4 | Intent router | giant `switch`, per-request LLM call | `DecisionRouter` |
| 5 | Composite scoring (ticket priority, PR risk, lead quality; weights in code) | hand-weighted formulas | `Decision` |
| 6 | Webhook/event classifier | payload parsing branches | `@RouteByDecision` |
| 7 | Moderation / PII-in-text flag | blocklists | `DecisionPipe` |
| 8 | High-cardinality classify (>255 labels) | manual taxonomy trees | hierarchical + shortlist/rerank helper |
| 9 | Dynamic options (choices from DB, auto `other`) | static enums | `Decision` with `questions()` factory |
| 10 | Dependent chain (second question depends on first) | nested conditionals | `chain()` helper |

Every recipe doc follows: **Before** (the regex/if), **After** (the decision), **Where it fails**, **How to calibrate thresholds**.

---

## 7. Adoption features (differentiators)

1. **Shadow mode** (v0.1): the zero-risk adoption path and the headline feature.
2. **Threshold tuner** (v0.3, CLI): input labeled JSONL, output suggested `auto`/`review` cut-offs with precision/recall table.
3. **Replay** (v0.3): re-run stored audit records against a candidate model before upgrading.
4. **Drift report** (v0.3): alert when the confidence distribution shifts.
5. **Schematics** (v0.3): `nest g decision ticket-triage` generates class, spec, fixtures; `npx nest-decisions init` wires the module and one example.
6. **Lint rule** (v0.3): flag decisions used for arithmetic/dates/auth, and `state` that spreads a whole DTO.

---

## 8. Security, privacy, trust

- Keys server-side only, read via `ConfigService`/options, never logged; Authorization headers excluded from audit/raw records.
- Docs lead with the data-policy warning: state leaves your infrastructure to a third party; use `redact` and minimal state; document provider data retention as something *the user must verify* with their provider.
- Prompt-injection stance: the gate is a signal, not the control; recommend defense in depth.
- Supply chain: npm provenance, 2FA, pinned lockfile, `SECURITY.md` with a reporting address, minimal deps, renovate with review.
- Honest accuracy page: where it fails (arithmetic, authorization, out-of-domain inputs), with a calibration guide. No invented benchmarks; any numbers cite reproducible scripts in the repo.

---

## 9. Testing strategy

- **Unit:** builders/validation, policy functions, fallback matrix (timeout, 5xx, malformed, budget, low confidence), cache keys, redaction, cost labeling, retry/backoff with fake timers.
- **Provider contract tests:** mocked HTTP (msw or undici MockAgent) for provider selection, retry, redirect refusal, malformed response, raw retention, no key leakage in logs.
- **Nest integration:** `Test.createTestingModule` for module wiring in `forRoot`, `forRootAsync` (all three styles), global and non-global use.
- **E2E:** supertest against Express and Fastify; GraphQL, WS and RPC contexts for the guard.
- **Examples as tests:** every recipe's spec runs in CI.
- **Live smoke (manual, opt-in):** gated by env var, never in default CI, reports provider and resolved model actually observed.
- Coverage gate (start at 90% lines for core), mutation testing on policy/threshold code optional later.

---

## 10. Documentation

Docs site (Starlight or Docusaurus):
1. **Why decisions** (the mindset), with before/after.
2. **Quickstart** (5 minutes, mock, no key; `npx nest-decisions init` once the CLI ships).
3. **Concepts:** noul / choice / score, confidence vs class, state design, thresholds.
4. **Recipes:** the ten above, by domain (support, e-commerce, fintech, moderation, DevOps).
5. **Production checklist:** credentials, budgets, fallback, audit retention, calibration, shadow rollout.
6. **Writing a provider.**
7. **API reference** generated with TypeDoc (`@publicApi` tags, as in throttler).
8. **Migration guides:** "from regex", "from per-request LLM calls".

Repo hygiene: `README`, `CONTRIBUTING`, `CODE_OF_CONDUCT`, `SECURITY`, `CHANGELOG` via changesets, issue/PR templates, `LICENSE` (MIT).

---

## 11. Roadmap and milestones

**M0: Foundations (week 1)**
- Monorepo, tooling, CI skeleton, license/community files, name re-verification, npm org/scope claim.
- Exit: CI green on an empty `core` with build + lint + test.

**M1: Core + Jev provider + testing (weeks 2-3), release `0.1.0-alpha`**
- Provider interface, question builders + validation, `DecisionsModule`, `Decision` base class, fallback policy, logger audit sink, redactor, shadow runner.
- `provider-jev` (ported client behavior + HTTP-mocked tests), `testing` package.
- Exit: recipe 2 (triage) works end-to-end on the mock and passes a manual live smoke test with a real key.

**M2: Surfaces + first recipes (weeks 4-5), release `0.1.0`**
- `@DecisionGuard`, `@Gated`, `DecisionRouter`, in-memory `ReviewQueue`, budget guard, cache.
- Recipes 1-4 with examples, quickstart, docs site v1, Express + Fastify e2e.
- Exit: a developer who has never seen the project builds a gated route in under 10 minutes using only the docs.

**M3: Production adapters (weeks 6-7), `0.2.0`**
- `audit-typeorm`, `queue-bullmq`, Terminus health, metrics/events, `provider-openrouter`, recipes 5-7, Bull/Kafka consumer decorator.

**M4: Calibration + DX (weeks 8-10), `0.3.0`**
- CLI: `init`, schematics, threshold tuner, replay, drift report; lint rule; generic LLM provider; recipes 8-10.

**M5: Launch + 1.0 criteria**
- Public API frozen and documented, 90%+ coverage, two real-world adopters' feedback incorporated, security review, launch post + demo video, listing on awesome-nestjs and Nest community channels, outreach to TypeSafe.

(Timeline assumes one developer part-time; adjust as needed.)

---

## 12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Vendor trademark/ToS issue with Jev naming | Neutral naming; Jev only in provider package; contact TypeSafe early |
| Sole provider dependency (alpha endpoint may change) | Provider interface, contract tests, generic LLM provider in M4 |
| Users misuse for auth/arithmetic | Docs, lint rule, "where it fails" sections, fail-closed defaults |
| PII leakage to third party | Required `state`, redactor hook, test recorder asserting sent state, data-policy docs |
| Cost surprise | Budget guard, cost labeling, dry-run/shadow, docs on per-call pricing as caller-supplied |
| Nest major-version churn (12.x current) | CI matrix across 10/11/12, peer range, renovate |
| Overpromising accuracy | Calibration tooling; no unsourced benchmark claims |
| Scope creep | Strict milestone exits; v0.1 ships only items marked v0.1 |

---

## 13. Open decisions

1. ~~Scope~~ **Decided:** `@nest-decisions/*` org (names looked free on npm and GitHub; claim the org first). Repo stays under `abd-wazzan` until a GitHub org exists.
2. ~~Linter~~ **Decided:** Biome, with `tsc --noEmit` as the type source of truth; fall back to oxlint + Prettier if decorator support misbehaves.
3. Docs engine: Starlight vs Docusaurus.
4. Drop Nest 10 support from the matrix to reduce CI cost?
5. ~~Contact TypeSafe~~ **Decided:** deferred until after the alpha.

## 14. First actions (when you say go)

1. Create the repo `abd-wazzan/nest-decisions` (private until `0.1.0`), init the pnpm + turbo monorepo with tooling and CI.
2. Implement `core` types, builders and validation, test-first.
3. Port the Jev client into `provider-jev` with mocked-HTTP contract tests.
4. Build `Decision` + `DecisionsModule`, then the triage recipe as the first vertical slice.
