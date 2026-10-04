/**
 * Stage every unpublished package for release with `npm stage publish`.
 *
 * npm is removing direct publishing with granular tokens (January 2027). Staging needs no 2FA, so
 * CI can do it with a "Read and write (stage only)" token, and a maintainer then approves each
 * staged version with 2FA (`npm stage approve`). Changesets has no staging mode, so Changesets does
 * the versioning and this script does the publishing step.
 *
 * It packs each package with pnpm, which rewrites `workspace:` ranges to real versions (plain npm
 * would leave them in), then stages the tarball. Safe to re-run: a version that is already
 * published, or already staged, is skipped.
 *
 *   node scripts/stage-publish.mjs            stage for real (needs NODE_AUTH_TOKEN)
 *   DRY_RUN=1 node scripts/stage-publish.mjs  show what would be staged, change nothing
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dryRun = process.env.DRY_RUN === '1';
const tarballs = mkdtempSync(join(tmpdir(), 'stage-'));

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...options });
  const spawnError = result.error ? `${result.error.message}\n` : '';
  return {
    ok: result.status === 0,
    out: `${spawnError}${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  };
}

/** `0.1.0-alpha.0` -> `alpha`; a release version -> `latest`. npm requires an explicit tag for prereleases. */
export function distTag(version) {
  const pre = version.split('-')[1];
  return pre ? pre.split('.')[0] : 'latest';
}

const packages = readdirSync(join(root, 'packages'))
  .map((dir) => join(root, 'packages', dir))
  .filter((dir) => existsSync(join(dir, 'package.json')))
  .map((dir) => ({ dir, ...JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) }))
  .filter((pkg) => !pkg.private);

const summary = { staged: [], skipped: [], failed: [] };

for (const pkg of packages) {
  const id = `${pkg.name}@${pkg.version}`;

  if (run('npm', ['view', id, 'version']).ok) {
    console.log(`skip   ${id} (already published)`);
    summary.skipped.push(id);
    continue;
  }

  const pack = run('pnpm', ['pack', '--pack-destination', tarballs], { cwd: pkg.dir });
  const tarball = pack.out.split('\n').at(-1)?.trim();
  if (!pack.ok || !tarball) {
    console.error(`FAIL   ${id}: pnpm pack failed\n${pack.out}`);
    summary.failed.push(id);
    continue;
  }

  const tag = distTag(pkg.version);
  const stage = run('npm', [
    'stage',
    'publish',
    tarball,
    '--tag',
    tag,
    '--access',
    'public',
    '--provenance',
    ...(dryRun ? ['--dry-run'] : []),
  ]);

  if (stage.ok) {
    console.log(`${dryRun ? 'would stage' : 'staged'} ${id} (tag ${tag})`);
    summary.staged.push(id);
  } else if (/already|exists|conflict|cannot publish over|E_STAGE_CONFLICT|EPUBLISHCONFLICT/i.test(stage.out)) {
    // A re-run after a successful stage: the version is already waiting for approval.
    console.log(`skip   ${id} (already staged)`);
    summary.skipped.push(id);
  } else {
    console.error(`FAIL   ${id}:\n${stage.out}`);
    summary.failed.push(id);
  }
}

console.log(
  `\n${summary.staged.length} ${dryRun ? 'would be staged' : 'staged'}, ${summary.skipped.length} skipped, ${summary.failed.length} failed.`,
);
if (summary.staged.length && !dryRun) {
  console.log(
    'Next: a maintainer reviews with `npm stage list` and approves each with `npm stage approve <stage-id> --otp <code>`.',
  );
}
process.exit(summary.failed.length ? 1 : 0);
