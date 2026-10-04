/**
 * Post-build smoke test: every package must load as ESM and CJS, expose identical exports, and
 * share one copy of each class (so Nest DI tokens and instanceof checks agree across formats).
 * Run after `pnpm build`.
 */
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
let failed = false;
for (const dir of readdirSync(join(root, 'packages'))) {
  const base = join(root, 'packages', dir);
  const cjs = require(join(base, 'dist/cjs/index.js'));
  const esm = await import(pathToFileURL(join(base, 'dist/esm/index.js')).href);
  const names = Object.keys(cjs).filter((n) => n !== '__esModule');
  const missing = names.filter((n) => !(n in esm));
  const differing = names.filter((n) => typeof cjs[n] === 'function' && esm[n] !== cjs[n]);
  if (missing.length || differing.length) {
    failed = true;
    console.error(`${dir}: missing in ESM [${missing}] / different identity [${differing}]`);
  } else {
    console.log(`${dir}: ${names.length} exports, one shared copy`);
  }
}
process.exit(failed ? 1 : 0);
