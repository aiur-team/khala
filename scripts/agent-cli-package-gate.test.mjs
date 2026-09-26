import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CONSUMER_HOOKS, OLD_PACKAGE_NAME, OPENCODE_EXPORT, closureErrors, PACKED_FILES, PAYLOAD_FILES, gatePackage, manifestErrors, oldIdentityReferences, packedFileErrors,
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

// A detached copy of the CLI package that bundles from its own `node_modules`.
function copyPackage(t) {
  const copy = temporary('khala-gate-fixture-');
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  for (const entry of ['package.json', 'README.md', 'scripts', 'src']) {
    fs.cpSync(path.join(packageDirectory, entry), path.join(copy, entry), { recursive: true });
  }
  fs.mkdirSync(path.join(copy, 'node_modules'));
  for (const entry of ['@khala', 'esbuild', 'zod']) fs.symlinkSync(fs.realpathSync(path.join(packageDirectory, 'node_modules', entry)), path.join(copy, 'node_modules', entry));
  return copy;
}

// A copy of the CLI package whose bundled runtime closure gains a third-party
// package with a `postinstall` script, as a transitive dependency would bring.
function packageWithTransitiveHook(t) {
  const copy = copyPackage(t);
  const modules = path.join(copy, 'node_modules');
  const injected = path.join(modules, 'khala-telemetry');
  fs.mkdirSync(injected);
  fs.writeFileSync(path.join(injected, 'package.json'), JSON.stringify({
    name: 'khala-telemetry', version: '1.0.0', type: 'module', main: 'index.js', scripts: { postinstall: 'node collect.js' },
  }));
  fs.writeFileSync(path.join(injected, 'index.js'), 'globalThis.khalaTelemetry = true;\n');
  const main = path.join(copy, 'src/cli/main.ts');
  const source = fs.readFileSync(main, 'utf8');
  assert.ok(source.startsWith('#!/usr/bin/env node\n'));
  fs.writeFileSync(main, source.replace('#!/usr/bin/env node\n', "#!/usr/bin/env node\nimport 'khala-telemetry';\n"));
  return copy;
}

test('the packed CLI passes the gate, runs, and imports @aiur/khala/opencode from a fresh prefix', t => {
  const { errors, tarball, prefix } = gate(t, { packageDirectory });
  assert.deepEqual(errors, []);
  assert.match(path.basename(tarball), /^aiur-khala-\d+\.\d+\.\d+\.tgz$/);
  const resolved = spawnSync(process.execPath, ['--input-type=module', '-e', `console.log(import.meta.resolve(${JSON.stringify(OPENCODE_EXPORT)}))`], { cwd: prefix, encoding: 'utf8' });
  assert.equal(fs.realpathSync(fileURLToPath(resolved.stdout.trim())), fs.realpathSync(path.join(prefix, 'node_modules/@aiur/khala/dist/opencode.js')));
});

test('an @aiur/khala/opencode export with only the source condition fails the gate', () => {
  const exports = { ...sourceManifest.exports, './opencode': { 'khala-source': './src/opencode/index.ts' } };
  assert.deepEqual(manifestErrors({ ...sourceManifest, exports }), ['export ./opencode must resolve to dist/opencode.js for consumers (null)']);
});

// The pinned OpenCode the adapter supports; the proof runs only where it is installed.
const OPENCODE_VERSION = '1.17.10';
const openCodeVersion = spawnSync('opencode', ['--version'], { encoding: 'utf8' });
const hasOpenCode = openCodeVersion.status === 0 && openCodeVersion.stdout.trim() === OPENCODE_VERSION;

// Runs the real OpenCode in an isolated home with one `plugin` entry and returns the
// build agent's configuration, which lists every tool a loaded plugin registered.
function openCodeWithPlugin(t, entry) {
  const base = temporary('khala-opencode-load-');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dirs = Object.fromEntries(['home', 'config/opencode', 'data', 'state', 'cache', 'project'].map(name => [name, path.join(base, name)]));
  for (const directory of Object.values(dirs)) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(dirs['config/opencode'], 'opencode.json'), `${JSON.stringify({ plugin: [entry] })}\n`);
  const result = spawnSync('opencode', ['debug', 'agent', 'build'], {
    cwd: dirs.project, encoding: 'utf8', timeout: 90_000,
    env: { ...process.env, HOME: dirs.home, XDG_CONFIG_HOME: path.join(base, 'config'), XDG_DATA_HOME: dirs.data, XDG_STATE_HOME: dirs.state, XDG_CACHE_HOME: dirs.cache },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test(`OpenCode ${OPENCODE_VERSION} loads the installed plugin through the file URL setup writes`, { skip: !hasOpenCode && `needs opencode ${OPENCODE_VERSION} on PATH` }, t => {
  const { errors, prefix } = gate(t, { packageDirectory });
  assert.deepEqual(errors, []);
  // Setup's entry names the stable plugin file (`$XDG_DATA_HOME/khala/bin/opencode.js`),
  // a copy of the installed payload's `dist/opencode.js`.
  const dataHome = temporary('khala-opencode-data-');
  t.after(() => fs.rmSync(dataHome, { recursive: true, force: true }));
  const stable = path.join(dataHome, 'khala/bin/opencode.js');
  fs.mkdirSync(path.dirname(stable), { recursive: true });
  fs.copyFileSync(path.join(prefix, 'node_modules/@aiur/khala/dist/opencode.js'), stable);
  const loaded = openCodeWithPlugin(t, pathToFileURL(stable).href);
  assert.match(loaded, /khala_read/);
  assert.match(loaded, /khala_send/);
  // OpenCode installs a bare entry as one npm package name, so the subpath export never loads.
  assert.doesNotMatch(openCodeWithPlugin(t, OPENCODE_EXPORT), /khala_read|khala_send/);
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
    'tarball is missing dist/opencode.js',
    ...PAYLOAD_FILES.map(file => `tarball is missing ${file}`),
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
