# Releasing

Releases are automated up to the last step, and that step is a human one. CI **stages** each new
version on npm; a maintainer **approves** it with two-factor authentication. Nothing becomes public
until then.

npm is removing direct publishing with granular access tokens in January 2027, so this repository
uses npm's staged publishing from the start: a leaked CI token can stage a version but cannot
release one.

## The flow

1. **Add a changeset** in your pull request when you change a published package:
   `pnpm changeset`, pick the packages, pick the bump (patch, minor), write one line for the changelog.
2. CI must pass: lint, typecheck, tests on Node 20, 22 and 24, Nest 10, 11 and 12, build,
   `publint`, `attw`, the ESM/CJS identity check, and the docs build.
3. Merge to `main`. The **Release** workflow opens or updates a **"chore: version packages"**
   pull request that bumps versions and writes changelogs.
4. Merging that pull request makes the workflow **stage** every package whose version is not yet on
   npm (`scripts/stage-publish.mjs`), with provenance.
5. **A maintainer approves each staged version** (below). Then it is public.

## Approving staged versions

You need an npm account with 2FA and write access to the packages.

```bash
npm stage list @nest-decisions/core                 # what is waiting, with stage ids
npm stage view <stage-id>                           # details of one staged version
npm stage download <stage-id>                       # optional: inspect the exact tarball
npm stage approve <stage-id> --otp <code>           # publish it
npm stage reject <stage-id> --otp <code>            # discard it
```

Approve all five packages of a release. They share one version number, so approving only some of
them leaves an inconsistent set on npm. Staged versions use the same version slot as published
ones: a version you reject can be staged again, but a published version can never be reused.

Optional, after approving: tag the release with `pnpm changeset tag && git push --follow-tags`.

## Versioning

- The packages are versioned **in lockstep** (a Changesets `fixed` group): they always share a
  version, so a compatible `core`, `testing`, `provider-jev`, `redis` and `bullmq` are one number.
- Internal peer ranges are written `workspace:^`. The staging script packs each package with pnpm,
  which rewrites them to a real range (for example `^0.1.0-alpha.0`); plain `npm pack` would leave
  `workspace:` in the published manifest and break installs.
- The repo is in **alpha pre-release mode**. Versions look like `0.1.0-alpha.0` and are staged
  under the `alpha` dist-tag, so `npm i @nest-decisions/core@alpha` installs them and a plain
  `npm i` does not pick one up.
- To leave alpha: `pnpm changeset pre exit`, commit, and the next version PR is a normal release.

## One-time setup (maintainer, on npm and GitHub)

1. Create the npm org `nest-decisions` and turn on 2FA for the org and your account.
2. Create the GitHub repository and push.
3. Create a **granular access token** with permission **Read and write (stage only)**, limited to
   the `@nest-decisions` scope, with a short expiry. Store it as the repository secret `NPM_TOKEN`.
   A stage-only token can stage new versions, deprecate versions and move dist-tags, but cannot
   publish. Staging can also create a package that does not exist yet, so the first release works
   with this token.
4. On npm, for each package once it exists, set the package access to **Require two-factor
   authentication and disallow tokens**, so a token can never publish it directly.
5. In the repository settings, protect `main` (require pull requests and the CI checks). Optionally
   create an environment named `release` and require a reviewer, so even staging waits for
   a human.
6. Merge the first "chore: version packages" pull request, then approve the staged versions.

**Later:** npm trusted publishing (tokenless, from GitHub Actions) can also be limited to staging.
Once the packages exist you can configure a trusted publisher per package that allows
`npm stage publish` only, and then delete `NPM_TOKEN`. Check npm's current trusted-publishing
documentation for the exact steps; it is not set up here.

The release job is separate from verification and installs dependencies with `--ignore-scripts`,
so no dependency lifecycle script runs in the job that holds the token.

**What is not verified yet:** the staging step has been run in dry-run mode only. The first real
run (after the org and token exist) is the real test. The script treats an "already staged"
error as a skip so a re-run is safe; if npm words that error differently, the re-run fails loudly
instead of silently passing, and the pattern in `scripts/stage-publish.mjs` needs adjusting.

## Documentation site

The docs are deployed to GitHub Pages by `.github/workflows/docs.yml` whenever `docs/` changes on
`main`. One-time setup: in the repository settings, open **Pages** and set the source to
**GitHub Actions**.

- Project site: `https://abd-wazzan.github.io/nest-decisions/` (the default base path
  `/nest-decisions/`).
- Organization root site (`https://nest-decisions.github.io/`) or a custom domain: set the
  repository variable `DOCS_BASE` to `/`, because the site then lives at the root.

## Checking a release

```bash
npm view @nest-decisions/core dist-tags
mkdir try && cd try && npm init -y && npm i @nest-decisions/core@alpha @nestjs/common @nestjs/core reflect-metadata
node -e "console.log(Object.keys(require('@nest-decisions/core')).length)"
```

On the npm package page, the provenance badge confirms the package was built and signed by this
repository's workflow.

## If something goes wrong

A published version cannot be replaced or reused. A staged one can be rejected and staged again, so
check what you approve (`npm stage view`, `npm stage download`). If a bad version is already
public, deprecate it (`npm deprecate`) and release the fix.
