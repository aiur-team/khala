import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('./package-task.mjs', import.meta.url));
function fixture(t, files = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-package-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', types: [] }, include: ['src/**/*.ts'] }));
  for (const [name, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    fs.writeFileSync(path.join(directory, name), source);
  }
  return directory;
}
const run = (cwd, task) => spawnSync(process.execPath, [runner, task], { cwd, encoding: 'utf8' });

test('empty package typechecks without fabricated source', t => {
  assert.equal(run(fixture(t), 'typecheck').status, 0);
});
test('invalid feature types fail the package gate', t => {
  const result = run(fixture(t, { 'src/feature.ts': 'export const count: number = "wrong";' }), 'typecheck');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not assignable to type 'number'/);
});
test('build emits feature code and removes stale output but excludes adjacent tests', t => {
  const directory = fixture(t, {
    'src/feature.ts': 'export const count: number = 3;',
    'src/feature.test.ts': 'export const testOnly = true;',
    'dist/stale.js': 'old output',
  });
  const result = run(directory, 'build');
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(path.join(directory, 'dist/feature.js'), 'utf8'), /count = 3/);
  assert.equal(fs.existsSync(path.join(directory, 'dist/feature.test.js')), false);
  assert.equal(fs.existsSync(path.join(directory, 'dist/stale.js')), false);
});
test('build keeps fakes and fixtures out of dist', t => {
  const directory = fixture(t, {
    'src/feature.ts': 'export const count: number = 3;',
    'src/fakes.ts': 'export const fakeThing = 1;',
    'src/nested/fakes.ts': 'export const nestedFake = 1;',
    'src/nested/fixtures/sample.ts': 'export const sample = 1;',
    'src/nested/fixtures/deeper/sample.ts': 'export const deeper = 1;',
    // A name that merely starts with "fakes" is real feature code, not a test double.
    'src/fakestore.ts': 'export const notAFake = 1;',
  });
  const result = run(directory, 'build');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(directory, 'dist/feature.js')), true);
  assert.equal(fs.existsSync(path.join(directory, 'dist/fakestore.js')), true);
  assert.equal(fs.existsSync(path.join(directory, 'dist/fakes.js')), false);
  assert.equal(fs.existsSync(path.join(directory, 'dist/nested/fakes.js')), false);
  assert.equal(fs.existsSync(path.join(directory, 'dist/nested/fixtures')), false);
});
