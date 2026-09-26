import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROVENANCE_SUFFIX, packForAcceptance } from './acceptance-pack.mjs';

function repository(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-acceptance-pack-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  git('init', '-q');
  fs.mkdirSync(path.join(directory, 'packages/agent-cli'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'packages/agent-cli/package.json'), '{}\n');
  fs.writeFileSync(path.join(directory, '.gitignore'), 'out/\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init');
  return { directory, commit: git('rev-parse', 'HEAD') };
}

/** Stands in for the release package gate: writes a tarball and reports it. */
function fakeGate(calls, effect = () => {}) {
  return ({ outputDirectory }) => {
    calls.push(outputDirectory);
    const tarball = path.join(outputDirectory, 'aiur-khala-0.1.0.tgz');
    fs.writeFileSync(tarball, 'packed bytes');
    effect();
    return { errors: [], tarball };
  };
}

test('packs a clean tree and records its commit and sha256 beside the tarball', t => {
  const { directory, commit } = repository(t);
  const calls = [];
  const result = packForAcceptance({ repositoryRoot: directory, outputDirectory: path.join(directory, 'out'), gate: fakeGate(calls) });
  assert.deepEqual(result.errors, []);
  const sha256 = createHash('sha256').update('packed bytes').digest('hex');
  assert.deepEqual(result.khalaPackage, { tarball: path.join(directory, 'out/aiur-khala-0.1.0.tgz'), sha256, commit });
  const provenance = JSON.parse(fs.readFileSync(`${result.khalaPackage.tarball}${PROVENANCE_SUFFIX}`, 'utf8'));
  assert.deepEqual(provenance, { v: 1, package: '@aiur/khala', commit, sha256, clean: true });
});

test('refuses a dirty tree before packing anything', t => {
  const { directory } = repository(t);
  fs.writeFileSync(path.join(directory, 'untracked.ts'), 'x');
  const calls = [];
  const result = packForAcceptance({ repositoryRoot: directory, outputDirectory: path.join(directory, 'out'), gate: fakeGate(calls) });
  assert.match(result.errors.join('\n'), /not clean/);
  assert.equal(result.khalaPackage, undefined);
  assert.deepEqual(calls, []);
});

test('refuses a tarball whose packing changed the tree, and records no provenance', t => {
  const { directory } = repository(t);
  const calls = [];
  const gate = fakeGate(calls, () => fs.writeFileSync(path.join(directory, 'packages/agent-cli/package.json'), '{"changed":true}\n'));
  const result = packForAcceptance({ repositoryRoot: directory, outputDirectory: path.join(directory, 'out'), gate });
  assert.match(result.errors.join('\n'), /changed the tree/);
  assert.equal(fs.existsSync(path.join(directory, `out/aiur-khala-0.1.0.tgz${PROVENANCE_SUFFIX}`)), false);
});
