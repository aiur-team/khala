// The committed setup manifest (`$XDG_STATE_HOME/khala/setup/manifest.v1.json`). One entry
// per managed path records the current Khala postimage and the path's original pre-Khala
// baseline: its hash (or absence) and the backup holding its byte-exact preimage. An
// upgrade carries that baseline forward, so removal restores the user's state from before
// the first setup rather than a prior Khala version.
import { HARNESS_IDS, SETUP_COMPONENTS, type HarnessId, type SetupComponent, type Sha256Digest } from './types.js';

export const MANIFEST_SCHEMA_VERSION = 1 as const;
export const MANIFEST_FILE = 'manifest.v1.json';

export type Ownership = 'installer' | 'foreign';

/**
 * `backup` is `<transaction>/<name>` below the backups directory and `mode` the preimage's
 * permission bits; both are `null` exactly when the baseline is absent.
 */
export type ManifestBaseline = Readonly<{ hash: Sha256Digest | null; backup: string | null; mode: number | null }>;

export type ManifestEntry = Readonly<{
  path: string;
  harness: HarnessId;
  component: SetupComponent;
  ownership: Ownership;
  operationId: string;
  postimage: Sha256Digest;
  mode: number;
  baseline: ManifestBaseline;
  /** Directories Khala created for this path; removed (when empty) once the path returns to absence. */
  createdDirectories: readonly string[];
}>;

export type SetupManifest = Readonly<{
  v: typeof MANIFEST_SCHEMA_VERSION;
  transaction: string;
  planDigest: Sha256Digest;
  entries: readonly ManifestEntry[];
}>;

export class ManifestSchemaError extends Error {
  constructor(readonly path: string, readonly unsupportedVersion = false) {
    super(`invalid setup manifest at ${path}`);
    this.name = 'ManifestSchemaError';
  }
}

type Rec = Record<string, unknown>;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const BACKUP_REF = /^[0-9a-f-]{36}\/[0-9]+$/;

function fail(at: string): never { throw new ManifestSchemaError(at); }
function rec(value: unknown, at: string, keys: readonly string[]): Rec {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(at);
  const object = value as Rec;
  for (const key of Object.keys(object)) if (!keys.includes(key)) fail(`${at}.${key}`);
  for (const key of keys) if (!Object.hasOwn(object, key)) fail(`${at}.${key}`);
  return object;
}
function str(value: unknown, at: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(at);
  return value;
}
function digest(value: unknown, at: string): Sha256Digest {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail(at);
  return value as Sha256Digest;
}
function oneOf<T extends string>(value: unknown, members: readonly T[], at: string): T {
  if (typeof value !== 'string' || !(members as readonly string[]).includes(value)) fail(at);
  return value as T;
}
export function fileMode(value: unknown, at: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0o7777) fail(at);
  return value;
}
function absolute(value: unknown, at: string): string {
  const text = str(value, at);
  if (!text.startsWith('/') || text.split('/').includes('..')) fail(at);
  return text;
}

export function decodeBaseline(value: unknown, at: string): ManifestBaseline {
  const o = rec(value, at, ['hash', 'backup', 'mode']);
  const hash = o.hash === null ? null : digest(o.hash, `${at}.hash`);
  const backup = o.backup === null ? null : str(o.backup, `${at}.backup`);
  if (backup !== null && !BACKUP_REF.test(backup)) fail(`${at}.backup`);
  const mode = o.mode === null ? null : fileMode(o.mode, `${at}.mode`);
  // A present baseline always has a backup and mode, and an absent one never does.
  if ((hash === null) !== (backup === null) || (hash === null) !== (mode === null)) fail(at);
  return { hash, backup, mode };
}

export function decodeManifestEntry(value: unknown, at: string): ManifestEntry {
  const o = rec(value, at, ['path', 'harness', 'component', 'ownership', 'operationId', 'postimage', 'mode',
    'baseline', 'createdDirectories']);
  if (!Array.isArray(o.createdDirectories)) fail(`${at}.createdDirectories`);
  const ownership = oneOf(o.ownership, ['installer', 'foreign'] as const, `${at}.ownership`);
  const baseline = decodeBaseline(o.baseline, `${at}.baseline`);
  if (ownership === 'installer' && baseline.hash !== null) fail(`${at}.baseline`);
  return {
    path: absolute(o.path, `${at}.path`),
    harness: oneOf(o.harness, HARNESS_IDS, `${at}.harness`),
    component: oneOf(o.component, SETUP_COMPONENTS, `${at}.component`),
    ownership,
    operationId: str(o.operationId, `${at}.operationId`),
    postimage: digest(o.postimage, `${at}.postimage`),
    mode: fileMode(o.mode, `${at}.mode`),
    baseline,
    createdDirectories: o.createdDirectories.map((item, index) => absolute(item, `${at}.createdDirectories[${index}]`)),
  };
}

export function decodeManifest(value: unknown): SetupManifest {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const version = (value as Rec).v;
    if (typeof version === 'number' && version !== MANIFEST_SCHEMA_VERSION) throw new ManifestSchemaError('$.v', true);
  }
  const o = rec(value, '$', ['v', 'transaction', 'planDigest', 'entries']);
  if (o.v !== MANIFEST_SCHEMA_VERSION) fail('$.v');
  if (!Array.isArray(o.entries)) fail('$.entries');
  const entries = o.entries.map((entry, index) => decodeManifestEntry(entry, `$.entries[${index}]`));
  const paths = entries.map(entry => entry.path);
  if (new Set(paths).size !== paths.length) fail('$.entries');
  return {
    v: MANIFEST_SCHEMA_VERSION,
    transaction: str(o.transaction, '$.transaction'),
    planDigest: digest(o.planDigest, '$.planDigest'),
    entries: sortEntries(entries),
  };
}

export function sortEntries(entries: readonly ManifestEntry[]): ManifestEntry[] {
  return [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function encodeManifest(manifest: SetupManifest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ ...manifest, entries: sortEntries(manifest.entries) }) + '\n');
}

export function parseManifest(bytes: Uint8Array): SetupManifest {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ManifestSchemaError('$');
  }
  return decodeManifest(value);
}

/** Transaction directories under `backups/` that the manifest still needs. */
export function referencedBackupTransactions(manifest: SetupManifest | null): Set<string> {
  const referenced = new Set<string>();
  for (const entry of manifest?.entries ?? []) {
    if (entry.baseline.backup !== null) referenced.add(entry.baseline.backup.split('/')[0]!);
  }
  return referenced;
}
