# Trying it with real teams

The most valuable thing right now is not another feature: it is a few Nest developers using one
recipe and telling us where it breaks. This page is for the maintainer running those sessions.

## Who to ask

3 to 5 Nest developers who have a real "guessing" spot in their code: a regex, a keyword list, a
hard-coded `if` that routes, filters or approves something. Ideally one of them has traffic to
shadow against. Not people who will be polite.

## The session (45 minutes, screen shared, you say as little as possible)

1. **5 min: their problem.** Ask which decision in their app is a regex or an `if` today. Do not
   explain the library yet.
2. **5 min: the demo.** Run `examples/support-desk` (`pnpm start`, no key needed) and show the
   three `curl` calls from its README. One minute each, no slides.
3. **25 min: they build one.** Ask them to write a `Decision` for *their* problem from
   `docs/quickstart.md`, using `DecisionsTestingModule` so no key is needed. **Do not help** until
   they have been stuck for two minutes. Write down where they got stuck and what they said.
4. **10 min: shadow mode.** Ask how they would try it next to their current code, and show
   `shadowRun` and `candidateFrom`.

## What to record

- Where they got stuck, with the exact words they used. Those are the bugs in the docs.
- Which part they did **not** understand: `state()` vs `policy()`, `fallback`, the 202 review
  response, `override`, the thresholds.
- Whether they would use it. Ask "what would stop you from putting this in your service?", and
  write down the answer, not a score.
- What they expected to exist and does not.

## What to look for

| Signal | Means |
|---|---|
| They reach for a plain `if` instead of `policy()` | the class shape is too heavy for small cases |
| They skip `state()` and pass the whole object | the "minimal state" message is not landing |
| They set thresholds by guessing | calibration needs to be earlier in the docs |
| They ask for another provider | the single-provider position is a blocker for them |
| They ask how to run it across several servers | the adapters page needs to be easier to find |
| They stop at the first failing test | the Vitest/decorator notes are not visible enough |

## After each session

Fix the docs first (the quickest win), then open an issue per real problem, then decide what to
build. Resist adding a feature for one person's request until a second person asks for it.

## Do not

- Offer the alpha as production-ready: it is pre-alpha and the thresholds in the recipes are
  illustrations from a small hand-labelled set.
- Send anyone a real API key, or ask them to send personal data to a model. Use the mock or
  synthetic data.
