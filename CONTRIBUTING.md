# Contributing

Thanks for helping. This is a small monorepo of three packages; most changes touch one.

## Setup

```bash
pnpm install
pnpm verify   # lint, typecheck, tests, build, and an ESM/CJS identity check
```

Node 20.19+ and pnpm 12.

## Making a change

1. Write the test first for policy, validation and failure-handling code.
2. Keep `state()` explicit and minimal in any example: never spread a whole DTO into the model.
3. Add a changeset for any change to a published package: `pnpm changeset`.
4. Update the docs in `docs/` when behavior or the public API changes.
5. Open a pull request. CI runs lint, typecheck, tests across Node and Nest versions, and package checks.

## Principles worth knowing before you propose something

- **Fail closed.** An unavailable decision throws unless the decision declares a `fallback`.
- **Minimal state.** Nothing is sent to a provider by default.
- **No secrets or personal data** in code, tests, fixtures, logs or audit records.
- **Provider-neutral core.** Provider specifics belong in a provider package.
- **Honest numbers.** Do not add accuracy claims without a script in the repo that reproduces them.

## Docs

The documentation site is VitePress, with the Markdown in `docs/` as the source.
`pnpm docs:dev` serves it locally and `pnpm docs:build` builds it; the build fails on a dead link, and
CI runs it on every pull request. Add a new page to the sidebar in `docs/.vitepress/config.mts`.

## Releases

Maintainers release through automation, see [docs/releasing.md](./docs/releasing.md).

## Conduct and security

See [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md). Report vulnerabilities privately, see
[SECURITY.md](./SECURITY.md).
