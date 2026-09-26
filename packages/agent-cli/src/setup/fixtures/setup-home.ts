// Test-only helpers for the setup executor: synthetic homes, operation builders, plan
// digests, byte/mode/mtime snapshots, and a manifest-driven removal planner.
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sha256 } from '../filesystem.js';
import type { SetupManifest } from '../manifest.js';
import type { ExecutablePlan, SetupRoots } from '../transaction.js';
import type { HarnessId, SetupComponent, SetupOperation, Sha256Digest } from '../types.js';

export const bytes = (text: string) => new TextEncoder().encode(text);

export async function syntheticHome(): Promise<{ root: string; roots: SetupRoots }> {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(tmpdir(), 'khala-setup-')));
  const home = path.join(root, 'home');
  const roots = {
    home,
    xdgConfigHome: path.join(home, '.config'),
    xdgDataHome: path.join(home, '.local', 'share'),
    xdgStateHome: path.join(home, '.local', 'state'),
  };
  for (const directory of Object.values(roots)) await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  return { root, roots };
}

type Target = Readonly<{ harness?: HarnessId; component?: SetupComponent; id?: string }>;
const base = (target: string, options: Target, type: string) => ({
  id: options.id ?? `${type}:${target}`, harness: options.harness ?? 'claude', component: options.component ?? 'skill', path: target,
});

export const op = {
  create: (target: string, post: Uint8Array, options: Target = {}): SetupOperation =>
    ({ ...base(target, options, 'create'), type: 'file_create', postimage: sha256(post) }),
  replace: (target: string, pre: Uint8Array, post: Uint8Array, options: Target = {}): SetupOperation =>
    ({ ...base(target, options, 'replace'), type: 'file_replace', preimage: sha256(pre), postimage: sha256(post) }),
  set: (target: string, pre: Uint8Array | null, post: Uint8Array, options: Target = {}): SetupOperation =>
    ({ ...base(target, options, 'set'), type: 'config_entry_set', entry: 'mcp.khala', preimage: pre === null ? null : sha256(pre), postimage: sha256(post) }),
  delete: (target: string, pre: Sha256Digest, options: Target = {}): SetupOperation =>
    ({ ...base(target, options, 'delete'), type: 'file_delete', preimage: pre }),
  restore: (target: string, current: Sha256Digest, restored: Sha256Digest | null, options: Target = {}): SetupOperation =>
    ({ ...base(target, options, 'restore'), type: 'file_restore', current, restored }),
  vendor: (executable: string, writablePaths: readonly string[], options: Target = {}): SetupOperation =>
    ({ ...base(executable, options, 'vendor'), type: 'vendor_command', executable, args: ['plugin', 'install'], writablePaths }),
};

export function plan(
  command: 'setup' | 'remove',
  operations: readonly SetupOperation[],
  blobs: readonly Uint8Array[] = [],
  extra: Partial<Pick<ExecutablePlan, 'modes' | 'unsupportedHarnesses'>> = {},
): ExecutablePlan {
  return {
    command,
    planDigest: sha256(bytes(JSON.stringify({ command, operations }))),
    operations,
    contents: new Map(blobs.map(blob => [sha256(blob), blob])),
    ...extra,
  };
}

/** What a remove planner derives from the manifest: every path goes back to its pre-Khala baseline. */
export function removalPlan(manifest: SetupManifest): ExecutablePlan {
  return plan('remove', manifest.entries.map(entry => (entry.baseline.hash === null
    ? op.delete(entry.path, entry.postimage, { harness: entry.harness, component: entry.component })
    : op.restore(entry.path, entry.postimage, entry.baseline.hash, { harness: entry.harness, component: entry.component }))));
}

export type Snapshot = Record<string, string>;

/** Every entry below `root` with type, mode, content hash, and mtime. */
export async function snapshot(root: string, options: Readonly<{ exclude?: readonly string[]; mtimes?: boolean }> = {}): Promise<Snapshot> {
  const result: Snapshot = {};
  async function walk(directory: string): Promise<void> {
    for (const name of (await fsp.readdir(directory)).sort()) {
      const target = path.join(directory, name);
      if (options.exclude?.some(prefix => target === prefix || target.startsWith(prefix + path.sep))) continue;
      const stat = await fsp.lstat(target);
      const mode = (stat.mode & 0o7777).toString(8);
      const mtime = options.mtimes === true ? ` ${stat.mtimeMs}` : '';
      if (stat.isSymbolicLink()) result[target] = `link ${await fsp.readlink(target)}`;
      else if (stat.isDirectory()) {
        result[target] = `dir ${mode}${mtime}`;
        await walk(target);
      } else result[target] = `file ${mode} ${sha256(new Uint8Array(await fsp.readFile(target)))}${mtime}`;
    }
  }
  await walk(root);
  return result;
}
