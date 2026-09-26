// Packs `@aiur/khala` for the live acceptance runner from a clean tree at a
// recorded commit. It refuses tracked or untracked changes, packs through the
// release package gate, refuses if packing moved HEAD or changed the tree, and
// writes `<tarball>.provenance.json` beside the tarball. It prints the profile's
// `khalaPackage` value, `{ tarball, sha256, commit }`; the runner refuses the
// tarball unless its bytes and this record still match that value.
//
//   pnpm acceptance:pack --out <directory>

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatePackage } from './agent-cli-package-gate.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
// Read by `scripts/acceptance/adapters/package.ts`.
export const PROVENANCE_SUFFIX = '.provenance.json';

function git(repositoryRoot, args) {
  return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trim();
}

/** HEAD and every tracked or untracked change; ignored build output is not part of the tree. */
export function treeState(repositoryRoot) {
  return { commit: git(repositoryRoot, ['rev-parse', 'HEAD']), changes: git(repositoryRoot, ['status', '--porcelain', '--untracked-files=all']) };
}

export function packForAcceptance({ outputDirectory, repositoryRoot = root, gate = gatePackage }) {
  const before = treeState(repositoryRoot);
  if (before.changes) return { errors: [`the tree is not clean; commit or remove:\n${before.changes}`] };
  const destination = path.resolve(outputDirectory);
  fs.mkdirSync(destination, { recursive: true });
  const { errors, tarball } = gate({ packageDirectory: path.join(repositoryRoot, 'packages/agent-cli'), outputDirectory: destination });
  if (errors.length) return { errors };
  const after = treeState(repositoryRoot);
  if (after.commit !== before.commit || after.changes) return { errors: [`packing changed the tree or HEAD; the tarball is not from ${before.commit}`] };
  const sha256 = createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
  const provenance = { v: 1, package: '@aiur/khala', commit: before.commit, sha256, clean: true };
  fs.writeFileSync(`${tarball}${PROVENANCE_SUFFIX}`, `${JSON.stringify(provenance, null, 2)}\n`);
  return { errors: [], khalaPackage: { tarball, sha256, commit: before.commit } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputIndex = process.argv.indexOf('--out');
  if (outputIndex < 0 || !process.argv[outputIndex + 1]) {
    console.error('usage: pnpm acceptance:pack --out <directory>');
    process.exitCode = 2;
  } else {
    const { errors, khalaPackage } = packForAcceptance({ outputDirectory: process.argv[outputIndex + 1] });
    if (errors.length) {
      console.error(`acceptance pack refused:\n${errors.map(error => `- ${error}`).join('\n')}`);
      process.exitCode = 1;
    } else console.log(JSON.stringify({ khalaPackage }, null, 2));
  }
}
