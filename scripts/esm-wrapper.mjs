/**
 * Generate dist/esm/index.js as a thin wrapper over the CommonJS build.
 *
 * A separately compiled ESM copy would load a second set of classes next to the CJS one, so
 * `DecisionsService`, injection tokens and `instanceof DecisionUnavailableError` would differ
 * depending on how a package was imported. Re-exporting the CJS build keeps exactly one copy of
 * every class in a process, whichever way it is loaded. Type declarations are emitted separately.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const pkgDir = process.cwd();
const require = createRequire(join(pkgDir, 'package.json'));
const cjs = require(resolve(pkgDir, 'dist/cjs/index.js'));
const names = Object.keys(cjs).filter(
  (name) => name !== 'default' && name !== '__esModule' && /^[A-Za-z_$][\w$]*$/.test(name),
);
const source = `import { createRequire } from 'node:module';
const cjs = createRequire(import.meta.url)('../cjs/index.js');
export const { ${names.join(', ')} } = cjs;
`;
mkdirSync(join(pkgDir, 'dist/esm'), { recursive: true });
writeFileSync(join(pkgDir, 'dist/esm/index.js'), source);
writeFileSync(join(pkgDir, 'dist/esm/package.json'), '{"type":"module"}\n');
