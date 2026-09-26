// Packs `@aiur/khala` for the live acceptance runner from a clean tree at a
// recorded commit. It refuses tracked or untracked changes, packs through the
// release package gate in a fresh `git worktree` at that commit (so no ignored
// build output reaches the tarball), refuses if packing moved HEAD or changed
// the worktree, and writes `<tarball>.provenance.json` beside the tarball. It prints the profile's
// `khalaPackage` value, `{ tarball, sha256, commit }`; the runner refuses the
// tarball unless its bytes and this record still match that value.
//
//   pnpm acceptance:pack --out <directory>

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatePackage } from './agent-cli-package-gate.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
// Read by `scripts/acceptance/adapters/package.ts`.
export const PROVENANCE_SUFFIX = '.provenance.json';

function git(repositoryRoot, args) {
  return execFileSync('git', ['-C', path.resolve(repositoryRoot), ...args], { encoding: 'utf8' }).trim();
}

/** HEAD and every tracked or untracked change; ignored build output is not part of the tree. */
export function treeState(repositoryRoot) {
  return { commit: git(repositoryRoot, ['rev-parse', 'HEAD']), changes: git(repositoryRoot, ['status', '--porcelain', '--untracked-files=all']) };
}

/** Installs the worktree's dependencies from the lockfile; nothing is built there before the gate runs. */
function installDependencies(worktree) {
  execFileSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], { cwd: worktree, stdio: ['ignore', 2, 2] });
}

export function packForAcceptance({ outputDirectory, repositoryRoot = root, gate = gatePackage, install = installDependencies }) {
  const before = treeState(repositoryRoot);
  if (before.changes) return { errors: [`the tree is not clean; commit or remove:\n${before.changes}`] };
  const destination = path.resolve(outputDirectory);
  fs.mkdirSync(destination, { recursive: true });
  // Ignored build output (a leftover `apps/web/dist/internal-web`, say) is invisible to
  // `git status` but the bundler would reuse it, so pack from a fresh worktree instead.
  const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-acceptance-pack-'));
  const worktree = path.join(scratch, 'tree');
  git(repositoryRoot, ['worktree', 'add', '--quiet', '--detach', worktree, before.commit]);
  try {
    install(worktree);
    const { errors, tarball } = gate({ packageDirectory: path.join(worktree, 'packages/agent-cli'), outputDirectory: destination });
    if (errors.length) return { errors };
    const after = treeState(worktree);
    if (after.commit !== before.commit || after.changes) return { errors: [`packing changed the tree or HEAD; the tarball is not from ${before.commit}`] };
    const sha256 = createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
    const provenance = { v: 1, package: '@aiur/khala', commit: before.commit, sha256, clean: true };
    fs.writeFileSync(`${tarball}${PROVENANCE_SUFFIX}`, `${JSON.stringify(provenance, null, 2)}\n`);
    return { errors: [], khalaPackage: { tarball, sha256, commit: before.commit } };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    git(repositoryRoot, ['worktree', 'prune']);
  }
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
