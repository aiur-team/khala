import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONSUMER_HOOKS, OLD_PACKAGE_NAME, closureErrors, PACKED_FILES, gatePackage, manifestErrors, oldIdentityReferences, packedFileErrors,
} from './agent-cli-package-gate.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const packageDirectory = path.join(root, 'packages/agent-cli');
const sourceManifest = JSON.parse(fs.readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'));
const temporary = prefix => fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), prefix));

function gate(t, options) {
  const result = gatePackage(options);
  t.after(() => fs.rmSync(result.work, { recursive: true, force: true }));
  return result;
}

// A copy of the CLI package whose bundled runtime closure gains a third-party
// package with a `postinstall` script, as a transitive dependency would bring.
function packageWithTransitiveHook(t) {
  const copy = temporary('khala-gate-fixture-');
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  for (const entry of ['package.json', 'README.md', 'scripts', 'src']) {
    fs.cpSync(path.join(packageDirectory, entry), path.join(copy, entry), { recursive: true });
  }
  const modules = path.join(copy, 'node_modules');
  fs.mkdirSync(modules);
  for (const entry of ['@khala', 'esbuild']) fs.symlinkSync(fs.realpathSync(path.join(packageDirectory, 'node_modules', entry)), path.join(modules, entry));
  const injected = path.join(modules, 'khala-telemetry');
  fs.mkdirSync(injected);
  fs.writeFileSync(path.join(injected, 'package.json'), JSON.stringify({
    name: 'khala-telemetry', version: '1.0.0', type: 'module', main: 'index.js', scripts: { postinstall: 'node collect.js' },
  }));
  fs.writeFileSync(path.join(injected, 'index.js'), 'globalThis.khalaTelemetry = true;\n');
  const main = path.join(copy, 'src/cli/main.ts');
  fs.writeFileSync(main, fs.readFileSync(main, 'utf8').replace("import { realpathSync }", "import 'khala-telemetry';\nimport { realpathSync }"));
  return copy;
}

test('the packed CLI passes the gate and runs from a fresh prefix', t => {
  const { errors, tarball } = gate(t, { packageDirectory });
  assert.deepEqual(errors, []);
  assert.match(path.basename(tarball), /^aiur-khala-\d+\.\d+\.\d+\.tgz$/);
});

test('a transitive postinstall bundled into the CLI fails the gate before release', t => {
  const { errors } = gate(t, { packageDirectory: packageWithTransitiveHook(t) });
  assert.ok(
    errors.includes('bundled package khala-telemetry declares consumer lifecycle hook "postinstall"'),
    errors.join('\n'),
  );
});

test('a runtime dependency that would install a postinstall fails the gate', () => {
  const errors = manifestErrors({ ...sourceManifest, dependencies: { 'khala-telemetry': '1.0.0' } });
  assert.ok(errors.includes('package declares dependencies; the runtime closure must be bundled'), errors.join('\n'));
});

test('the package itself may not declare a consumer lifecycle hook', () => {
  for (const hook of CONSUMER_HOOKS) {
    const errors = manifestErrors({ ...sourceManifest, scripts: { ...sourceManifest.scripts, [hook]: 'node x.js' } });
    assert.deepEqual(errors, [`@aiur/khala declares consumer lifecycle hook "${hook}"`]);
  }
  assert.deepEqual(manifestErrors(sourceManifest), [], 'prepack is a publisher-side hook and stays allowed');
});

test('the bundle may keep no runtime import except a Node built-in', () => {
  const metafile = {
    inputs: { 'src/cli/main.ts': {} },
    outputs: { 'dist/khala.js': { imports: [
      { path: 'node:fs', external: true },
      { path: '@khala/contracts/delivery/index', external: true },
    ] } },
  };
  assert.deepEqual(closureErrors(metafile, packageDirectory), [
    'dist/khala.js keeps a runtime import of @khala/contracts/delivery/index; only Node built-ins may stay external',
  ]);
});

test('the tarball file list is an exact allowlist', () => {
  assert.deepEqual(packedFileErrors(PACKED_FILES), []);
  assert.deepEqual(packedFileErrors([...PACKED_FILES, 'src/cli/main.ts', 'dist/khala.js.meta.json']), [
    'tarball contains non-allowlisted file dist/khala.js.meta.json',
    'tarball contains non-allowlisted file src/cli/main.ts',
  ]);
  assert.deepEqual(packedFileErrors(['package.json', 'README.md']), [
    'tarball is missing dist/khala-internal.js',
    'tarball is missing dist/khala.js',
  ]);
});

test('publish metadata names @aiur/khala with provenance and keeps workspace source unexported', () => {
  assert.ok(manifestErrors({ ...sourceManifest, name: OLD_PACKAGE_NAME }).some(error => error.startsWith('package name is')));
  assert.ok(manifestErrors({ ...sourceManifest, private: true }).includes('package is private'));
  assert.ok(manifestErrors({ ...sourceManifest, publishConfig: { access: 'public' } }).includes('publishConfig must request public access with provenance'));
  assert.ok(manifestErrors({ ...sourceManifest, exports: { './cli/*': './src/cli/*.ts' } }).includes('export ./cli/* exposes a wildcard (./src/cli/*.ts)'));
});

test('no live manifest, source, or test retains the old package identity', () => {
  assert.deepEqual(oldIdentityReferences(root), []);
});

test('the release workflow publishes the gated tarball through OIDC without an npm token', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/release-khala-cli.yml'), 'utf8');
  assert.match(workflow, /^\s+id-token: write$/m);
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./);
  const gateStep = workflow.indexOf('node scripts/agent-cli-package-gate.mjs --out');
  const publishStep = workflow.indexOf('npm publish "$RUNNER_TEMP"/khala-package/');
  assert.ok(gateStep > 0 && publishStep > gateStep, 'the gate must run before the gated tarball is published');
  assert.match(workflow.slice(publishStep), /--provenance/);
});
