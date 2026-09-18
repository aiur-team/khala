import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const runner = path.join(root, 'scripts/package-task.mjs');

// Packages that carry a `fakes.ts` or `fixtures/` source next to a wildcard `exports`
// entry that could otherwise resolve it once built.
const GUARDED = [
  { dir: 'packages/harnesses', specifier: '@khala/harnesses/codex/fakes' },
  { dir: 'packages/messaging', specifier: '@khala/messaging/rooms/fixtures/fakes' },
  { dir: 'packages/policy', specifier: '@khala/policy/release/fixtures/sample' },
];

for (const { dir, specifier } of GUARDED) {
  test(`${dir}: build keeps test doubles out of dist and ${specifier} stays unexported`, t => {
    const packageDirectory = path.join(root, dir);
    const distDirectory = path.join(packageDirectory, 'dist');
    t.after(() => fs.rmSync(distDirectory, { recursive: true, force: true }));

    const build = spawnSync(process.execPath, [runner, 'build'], { cwd: packageDirectory, encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr);

    const distFiles = fs.readdirSync(distDirectory, { recursive: true }).filter(name => !fs.statSync(path.join(distDirectory, String(name))).isDirectory());
    for (const file of distFiles) {
      assert.doesNotMatch(String(file), /(?:^|[\\/])fakes\.[cm]?jsx?$/, `${file} is a fake compiled into dist`);
      assert.doesNotMatch(String(file), /(?:^|[\\/])fixtures[\\/]/, `${file} is a fixture compiled into dist`);
    }

    const resolve = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `import.meta.resolve(${JSON.stringify(specifier)})`],
      { cwd: packageDirectory, encoding: 'utf8' },
    );
    assert.notEqual(resolve.status, 0, `expected ${specifier} to be unresolvable`);
    assert.match(resolve.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
  });
}
