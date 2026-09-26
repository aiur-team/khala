// The setup executor. A confirmed setup/remove takes an exclusive process lock, recovers
// any earlier interrupted transaction, replans under the lock, and proceeds only when the
// fresh plan digest equals the confirmed one. It then checks every precondition before the
// first write, persists byte-exact backups and a `prepared` write-ahead journal, applies
// the stable-ordered operations one at a time (advancing the journal around each), verifies
// every postimage, and atomically publishes the next manifest. Any failure reverses the
// applied operations from their backups; a rollback that cannot be proven exact is recorded
// as `rollback_failed` and surfaces as `recovery_required`.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { currentLockIdentity, holderIsLive, type LockIdentity } from './lock-identity.js';
import { ConfinedFilesystem, SetupFilesystemError, sha256, type FileObservation } from './filesystem.js';
import {
  MANIFEST_FILE, ManifestSchemaError, decodeManifest, encodeManifest, fileMode, parseManifest,
  referencedBackupTransactions, sortEntries, type ManifestEntry, type Ownership, type SetupManifest,
} from './manifest.js';
import {
  SetupSchemaError, decodeSetupResult, type HarnessId, type OperationStatus, type SetupDiagnostic,
  type SetupOperation, type SetupOperationReport, type Sha256Digest,
} from './types.js';

export const JOURNAL_SCHEMA_VERSION = 1 as const;
export const JOURNAL_FILE = 'transaction.v1.json';
const LOCK_FILE = 'lock';
const BACKUPS = 'backups';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type SetupRoots = Readonly<{ home: string; xdgConfigHome: string; xdgDataHome: string; xdgStateHome: string }>;

export type SetupStatePaths = Readonly<{
  /** `$XDG_STATE_HOME/khala/setup`: manifest, journal, lock, and backups. */
  stateDirectory: string;
  /** `$XDG_DATA_HOME/khala`: every path below it is installer-owned. */
  installerRoot: string;
  manifest: string;
  journal: string;
  lock: string;
  backups: string;
}>;

export function setupStatePaths(roots: SetupRoots): SetupStatePaths {
  const stateDirectory = path.join(roots.xdgStateHome, 'khala', 'setup');
  return {
    stateDirectory,
    installerRoot: path.join(roots.xdgDataHome, 'khala'),
    manifest: path.join(stateDirectory, MANIFEST_FILE),
    journal: path.join(stateDirectory, JOURNAL_FILE),
    lock: path.join(stateDirectory, LOCK_FILE),
    backups: path.join(stateDirectory, BACKUPS),
  };
}

/** A confirmed plan plus the bytes it writes. Operations carry only hashes; `contents` supplies the bytes. */
export type ExecutablePlan = Readonly<{
  command: 'setup' | 'remove';
  planDigest: Sha256Digest;
  operations: readonly SetupOperation[];
  /** Postimage bytes keyed by digest for every create/replace/config write in the plan. */
  contents: ReadonlyMap<Sha256Digest, Uint8Array>;
  /** Exact modes for installer-owned files whose mode is not the default (0400; launchers 0500). */
  modes?: ReadonlyMap<string, number>;
  /** Detected harnesses with an unsupported version: setup refuses before mutation, remove proceeds. */
  unsupportedHarnesses?: readonly HarnessId[];
}>;

/** Runs a resolved absolute executable with an argument array, no shell, and exactly `env`. */
export type VendorCommandRunner = (executable: string, args: readonly string[], env: Readonly<Record<string, string>>) => Promise<void>;

export const runVendorCommand: VendorCommandRunner = (executable, args, env) => new Promise((resolve, reject) => {
  execFile(executable, [...args], { env: { ...env }, shell: false, timeout: 120_000, windowsHide: true },
    error => (error ? reject(error) : resolve()));
});

export type ExecuteOptions = Readonly<{
  roots: SetupRoots;
  /** PATH handed to vendor commands; nothing else from the ambient environment is inherited. */
  searchPath: string;
  confirmedDigest: Sha256Digest;
  /** The planner, rerun under the lock against the committed manifest. */
  replan: (manifest: SetupManifest | null) => Promise<ExecutablePlan>;
  runVendorCommand?: VendorCommandRunner;
  /** Fault-injection seam: called at every durable boundary; a throw fails the transaction there. */
  boundary?: (name: string) => void | Promise<void>;
  transactionId?: () => string;
}>;

export type ExecutionOutcome =
  | Readonly<{ kind: 'committed'; changed: boolean; plan: ExecutablePlan; operations: readonly SetupOperationReport[] }>
  | Readonly<{ kind: 'busy'; diagnostics: readonly SetupDiagnostic[] }>
  | Readonly<{ kind: 'replanned'; plan: ExecutablePlan }>
  | Readonly<{ kind: 'refused'; state: 'drifted' | 'conflict' | 'unsupported'; diagnostics: readonly SetupDiagnostic[] }>
  | Readonly<{ kind: 'rolled_back'; operations: readonly SetupOperationReport[]; diagnostics: readonly SetupDiagnostic[] }>
  | Readonly<{ kind: 'recovery_required'; operations: readonly SetupOperationReport[]; diagnostics: readonly SetupDiagnostic[] }>;

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

type JournalTarget = {
  path: string;
  /** The hash (or absence) before this transaction touched the path. */
  preimage: Sha256Digest | null;
  mode: number | null;
  backup: string | null;
  /** The expected hash after the operation; unknown only for a vendor command not yet observed. */
  postimage: Sha256Digest | null;
  postimageKnown: boolean;
  createdDirectories: string[];
};
type JournalOperation = { operation: SetupOperation; status: 'planned' | 'applying' | 'applied'; targets: JournalTarget[] };
export type JournalState = 'prepared' | 'committed' | 'rollback_failed';
type Journal = {
  v: typeof JOURNAL_SCHEMA_VERSION;
  id: string;
  command: 'setup' | 'remove';
  planDigest: Sha256Digest;
  state: JournalState;
  operations: JournalOperation[];
  /** The manifest to publish; set only once the journal is `committed` (`null` deletes it). */
  manifest: SetupManifest | null;
};

class JournalError extends Error {
  constructor(readonly unsupportedVersion: boolean) {
    super('invalid setup journal');
    this.name = 'JournalError';
  }
}

type Rec = Record<string, unknown>;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
function jrec(value: unknown, keys: readonly string[]): Rec {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new JournalError(false);
  const object = value as Rec;
  for (const key of Object.keys(object)) if (!keys.includes(key)) throw new JournalError(false);
  for (const key of keys) if (!Object.hasOwn(object, key)) throw new JournalError(false);
  return object;
}
function jcheck(condition: boolean): asserts condition {
  if (!condition) throw new JournalError(false);
}
const jdigest = (value: unknown): Sha256Digest | null => {
  if (value === null) return null;
  jcheck(typeof value === 'string' && DIGEST.test(value));
  return value as Sha256Digest;
};
const jpath = (value: unknown): string => {
  jcheck(typeof value === 'string' && path.isAbsolute(value) && path.resolve(value) === value);
  return value as string;
};

/** Reuses the frozen result decoder so a journal can never carry an operation the contract would reject. */
function decodeOperation(value: unknown): SetupOperation {
  jcheck(typeof value === 'object' && value !== null && !Array.isArray(value) && !Object.hasOwn(value, 'status'));
  try {
    const result = decodeSetupResult({
      v: 1, command: 'setup', ok: true, changed: false, state: 'ready', planDigest: null,
      confirmation: { required: false, confirmed: false }, harnesses: [], diagnostics: [],
      operations: [{ ...(value as Rec), status: 'planned' }],
    });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- strips the report-only field
    const { status, ...operation } = result.operations[0]!;
    return operation as SetupOperation;
  } catch (error) {
    if (error instanceof SetupSchemaError) throw new JournalError(false);
    throw error;
  }
}

function decodeJournal(bytes: Uint8Array): Journal {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new JournalError(false);
  }
  if (typeof value === 'object' && value !== null && typeof (value as Rec).v === 'number' && (value as Rec).v !== JOURNAL_SCHEMA_VERSION) {
    throw new JournalError(true);
  }
  const o = jrec(value, ['v', 'id', 'command', 'planDigest', 'state', 'operations', 'manifest']);
  jcheck(o.v === JOURNAL_SCHEMA_VERSION && typeof o.id === 'string' && UUID.test(o.id));
  jcheck(o.command === 'setup' || o.command === 'remove');
  jcheck(o.state === 'prepared' || o.state === 'committed' || o.state === 'rollback_failed');
  jcheck(Array.isArray(o.operations));
  const planDigest = jdigest(o.planDigest);
  jcheck(planDigest !== null);
  let manifest: SetupManifest | null = null;
  if (o.manifest !== null) {
    try {
      manifest = decodeManifest(o.manifest);
    } catch {
      throw new JournalError(false);
    }
  }
  jcheck(o.state === 'committed' || manifest === null);
  const operations = (o.operations as unknown[]).map((item): JournalOperation => {
    const op = jrec(item, ['operation', 'status', 'targets']);
    jcheck(op.status === 'planned' || op.status === 'applying' || op.status === 'applied');
    jcheck(Array.isArray(op.targets) && op.targets.length > 0);
    return {
      operation: decodeOperation(op.operation),
      status: op.status as JournalOperation['status'],
      targets: (op.targets as unknown[]).map((raw): JournalTarget => {
        const t = jrec(raw, ['path', 'preimage', 'mode', 'backup', 'postimage', 'postimageKnown', 'createdDirectories']);
        const preimage = jdigest(t.preimage);
        jcheck(typeof t.postimageKnown === 'boolean' && Array.isArray(t.createdDirectories));
        jcheck(t.backup === null || (typeof t.backup === 'string' && t.backup.startsWith(`${o.id as string}/`)
          && /^[0-9]+$/.test(t.backup.slice((o.id as string).length + 1))));
        jcheck((preimage === null) === (t.backup === null) && (preimage === null) === (t.mode === null));
        let mode: number | null = null;
        if (t.mode !== null) {
          try { mode = fileMode(t.mode, 'mode'); } catch { throw new JournalError(false); }
        }
        return {
          path: jpath(t.path), preimage, mode, backup: t.backup as string | null,
          postimage: jdigest(t.postimage), postimageKnown: t.postimageKnown as boolean,
          createdDirectories: (t.createdDirectories as unknown[]).map(jpath),
        };
      }),
    };
  });
  return { v: JOURNAL_SCHEMA_VERSION, id: o.id as string, command: o.command as Journal['command'], planDigest,
    state: o.state as JournalState, operations, manifest };
}

const encodeJson = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) + '\n');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const diagnostic = (code: string, message: string, operation?: SetupOperation): SetupDiagnostic => ({
  code, severity: 'error', message,
  ...(operation === undefined ? {} : { harness: operation.harness, component: operation.component }),
});

function precondition(operation: SetupOperation): Sha256Digest | null {
  switch (operation.type) {
    case 'file_create': return null;
    case 'file_restore': return operation.current;
    case 'vendor_command': throw new Error('vendor commands have no single precondition');
    default: return operation.preimage;
  }
}

function postimage(operation: SetupOperation): Sha256Digest | null {
  switch (operation.type) {
    case 'file_delete': return null;
    case 'file_restore': return operation.restored;
    case 'vendor_command': throw new Error('vendor commands have no declared postimage');
    default: return operation.postimage;
  }
}

const targetPaths = (operation: SetupOperation): readonly string[] =>
  operation.type === 'vendor_command' ? operation.writablePaths : [operation.path];

class Refusal extends Error {
  constructor(readonly state: 'drifted' | 'conflict' | 'unsupported', readonly diagnostic: SetupDiagnostic) {
    super(diagnostic.code);
  }
}

function report(journal: Journal | null, plan: readonly SetupOperation[], status: (op: JournalOperation | undefined) => OperationStatus) {
  return plan.map((operation, index) => ({ ...operation, status: status(journal?.operations[index]) }) as SetupOperationReport);
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

class Executor {
  readonly fs: ConfinedFilesystem;
  readonly paths: SetupStatePaths;

  constructor(readonly options: ExecuteOptions) {
    const { home, xdgConfigHome, xdgDataHome, xdgStateHome } = options.roots;
    this.fs = new ConfinedFilesystem([...new Set([home, xdgConfigHome, xdgDataHome, xdgStateHome])]);
    this.paths = setupStatePaths(options.roots);
  }

  async boundary(name: string): Promise<void> {
    await this.options.boundary?.(name);
  }

  isInstallerOwned(target: string): boolean {
    return target.startsWith(this.paths.installerRoot + path.sep);
  }

  // --- lock -----------------------------------------------------------------

  async acquireLock(): Promise<boolean> {
    await fsp.mkdir(this.options.roots.xdgStateHome, { recursive: true, mode: 0o700 });
    await this.fs.createDirectories(await this.fs.missingDirectories(this.paths.lock));
    const record = encodeJson({ ...currentLockIdentity() });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.fs.replace(this.paths.lock, null, record, 0o600);
        return true;
      } catch (error) {
        if (!(error instanceof SetupFilesystemError) || error.code !== 'precondition_failed') throw error;
      }
      const holder = await this.fs.observe(this.paths.lock).catch(() => null);
      if (holder === null) continue;
      const identity = lockIdentity(holder.bytes);
      if (identity !== null && holderIsLive(identity, processIsLive)) return false;
      // A dead holder's lock (or a reused pid from another boot or start time) is stale; its journal (if any) is recovered once we hold the lock.
      if (!(await this.reclaimStaleLock(holder.hash))) return false;
    }
    return false;
  }

  /**
   * Moves the stale lock aside with one atomic rename, so only one competitor can claim it.
   * If what moved is not the stale lock (another process just took the lock), it goes back.
   */
  async reclaimStaleLock(stale: Sha256Digest): Promise<boolean> {
    const aside = `${this.paths.lock}.stale-${randomUUID()}`;
    try {
      await fsp.rename(this.paths.lock, aside);
    } catch {
      return true;
    }
    const moved = await this.fs.observe(aside).catch(() => null);
    if (moved?.hash === stale) {
      await fsp.unlink(aside).catch(() => undefined);
      return true;
    }
    await fsp.link(aside, this.paths.lock).catch(() => undefined);
    await fsp.unlink(aside).catch(() => undefined);
    return false;
  }

  async releaseLock(): Promise<void> {
    const held = await this.fs.observe(this.paths.lock).catch(() => null);
    if (held !== null && lockPid(held.bytes) === process.pid) await this.fs.remove(this.paths.lock, held.hash).catch(() => undefined);
  }

  // --- state files ------------------------------------------------------------

  async readManifest(): Promise<SetupManifest | null> {
    const file = await this.fs.observe(this.paths.manifest);
    return file === null ? null : parseManifest(file.bytes);
  }

  async writeManifest(manifest: SetupManifest | null): Promise<void> {
    await this.fs.write(this.paths.manifest, manifest === null ? null : encodeManifest(manifest));
  }

  async writeJournal(journal: Journal): Promise<void> {
    await this.fs.write(this.paths.journal, encodeJson(journal));
  }

  backupPath(reference: string): string {
    return path.join(this.paths.backups, ...reference.split('/'));
  }

  async readBackup(reference: string, expected: Sha256Digest): Promise<Uint8Array> {
    const backup = await this.fs.observe(this.backupPath(reference));
    if (backup === null || backup.hash !== expected) throw new SetupFilesystemError('precondition_failed', this.backupPath(reference));
    return backup.bytes;
  }

  /** Deletes backup transaction directories no manifest entry references. */
  async collectBackups(manifest: SetupManifest | null): Promise<void> {
    const keep = referencedBackupTransactions(manifest);
    for (const name of (await this.fs.list(this.paths.backups)) ?? []) {
      if (!keep.has(name)) await this.fs.removeTree(path.join(this.paths.backups, name));
    }
    if (keep.size === 0) await this.fs.removeEmptyDirectories([this.paths.backups]);
  }

  // --- recovery ---------------------------------------------------------------

  /** Finalizes a committed journal or rolls back an interrupted one. `null` means clean. */
  async recover(): Promise<ExecutionOutcome | null> {
    const file = await this.fs.observe(this.paths.journal);
    if (file === null) return null;
    let journal: Journal;
    try {
      journal = decodeJournal(file.bytes);
    } catch (error) {
      if (error instanceof JournalError && error.unsupportedVersion) {
        return { kind: 'refused', state: 'unsupported', diagnostics: [diagnostic('journal_unsupported', 'The setup journal uses a newer schema; refusing to touch it.')] };
      }
      return { kind: 'recovery_required', operations: [], diagnostics: [diagnostic('journal_corrupt', 'The setup journal is unreadable; its transaction state is unknown.')] };
    }
    if (journal.state === 'committed') {
      await this.finalize(journal);
      return null;
    }
    const outcome = await this.rollback(journal, [], false);
    return outcome.kind === 'rolled_back' ? null : outcome;
  }

  async finalize(journal: Journal): Promise<void> {
    await this.writeManifest(journal.manifest);
    await this.boundary('manifest_published');
    await this.fs.write(this.paths.journal, null);
    await this.boundary('journal_removed');
    await this.collectBackups(journal.manifest);
    if (journal.manifest === null) await this.pruneInstallerRoot(this.paths.installerRoot);
  }

  /** After a clean remove, deletes the now-empty installer directory tree (never a file). */
  async pruneInstallerRoot(directory: string): Promise<void> {
    for (const name of (await this.fs.list(directory)) ?? []) {
      const child = path.join(directory, name);
      const stat = await fsp.lstat(child).catch(() => null);
      if (stat?.isDirectory() === true && !stat.isSymbolicLink()) await this.pruneInstallerRoot(child);
    }
    await this.fs.removeEmptyDirectories([directory]);
  }

  /**
   * Reverses every started operation, newest first. Deterministic for a given journal and disk
   * state. `immediate` is true only inside the failing transaction itself, which has held the
   * lock throughout; a later recovery cannot attribute unobserved changes to this transaction.
   */
  async rollback(journal: Journal, cause: readonly SetupDiagnostic[], immediate: boolean): Promise<ExecutionOutcome> {
    const diagnostics = [...cause];
    const outcome = new Map<number, OperationStatus>();
    for (let index = journal.operations.length - 1; index >= 0; index -= 1) {
      const entry = journal.operations[index]!;
      if (entry.status === 'planned') continue;
      let exact = true;
      for (const target of [...entry.targets].reverse()) {
        try {
          await this.restoreTarget(target, entry.status === 'applying', immediate);
        } catch {
          exact = false;
          diagnostics.push(diagnostic('rollback_failed', `Could not prove ${target.path} returned to its preimage; it was preserved.`, entry.operation));
        }
      }
      outcome.set(index, exact ? 'rolled_back' : 'rollback_failed');
    }
    const operations = journal.operations.map(({ operation }, index) => ({ ...operation, status: outcome.get(index) ?? 'planned' }) as SetupOperationReport);
    if ([...outcome.values()].includes('rollback_failed')) {
      await this.writeJournal({ ...journal, state: 'rollback_failed' });
      return { kind: 'recovery_required', operations, diagnostics };
    }
    await this.fs.write(this.paths.journal, null);
    // Only this transaction's own backups are garbage now; baseline backups belong to the manifest.
    await this.fs.removeTree(path.join(this.paths.backups, journal.id));
    await this.fs.removeEmptyDirectories([this.paths.backups]);
    return { kind: 'rolled_back', operations, diagnostics };
  }

  async restoreTarget(target: JournalTarget, inFlight: boolean, immediate: boolean): Promise<void> {
    const current = await this.fs.hashOf(target.path);
    // Writes are atomic, so an in-flight operation left its path at either the preimage or the
    // postimage; any other content was never ours and is preserved untouched.
    const untouched = inFlight && target.postimageKnown && current !== target.postimage;
    if (current !== target.preimage && !untouched) {
      // Only a path still holding this transaction's postimage is ours to reverse. An unobserved
      // vendor write is reversible only by the transaction that ran it, still under its lock.
      if (target.postimageKnown ? current !== target.postimage : !immediate) {
        throw new SetupFilesystemError('precondition_failed', target.path);
      }
      if (target.preimage === null) {
        await this.fs.remove(target.path, current!);
      } else {
        const bytes = await this.readBackup(target.backup!, target.preimage);
        await this.fs.createDirectories(await this.fs.missingDirectories(target.path));
        await this.fs.replace(target.path, current, bytes, target.mode!);
      }
      await this.fs.verify(target.path, target.preimage, target.mode);
    }
    await this.fs.removeEmptyDirectories(target.createdDirectories);
  }

  // --- validation ---------------------------------------------------------------

  async validate(plan: ExecutablePlan, manifest: SetupManifest | null): Promise<Map<string, FileObservation | null>> {
    const entries = new Map((manifest?.entries ?? []).map(entry => [entry.path, entry]));
    const observed = new Map<string, FileObservation | null>();
    const refuse = (state: 'drifted' | 'conflict', code: string, message: string, operation?: SetupOperation): never => {
      throw new Refusal(state, diagnostic(code, message, operation));
    };
    if (plan.command === 'setup' && (plan.unsupportedHarnesses?.length ?? 0) > 0) {
      throw new Refusal('unsupported', diagnostic('unsupported_harness', `Unsupported harness version detected: ${plan.unsupportedHarnesses!.join(', ')}.`));
    }
    const ids = new Set<string>();
    for (const operation of plan.operations) {
      if (ids.has(operation.id)) refuse('conflict', 'invalid_plan', `Duplicate operation id ${operation.id}.`, operation);
      ids.add(operation.id);
      for (const target of targetPaths(operation)) {
        if (observed.has(target)) refuse('conflict', 'invalid_plan', `${target} is targeted twice in one plan.`, operation);
        if (target === this.paths.stateDirectory || target.startsWith(this.paths.stateDirectory + path.sep)) {
          refuse('conflict', 'unsafe_path', `${target} is executor state.`, operation);
        }
        try {
          observed.set(target, await this.fs.observe(target));
        } catch (error) {
          refuse('conflict', 'unsafe_path', `${target} is outside the setup roots, crosses a symbolic link, or is not a regular file.`, operation);
          throw error;
        }
      }
    }
    // Every managed path of every selected harness must still hold its recorded postimage.
    const harnesses = new Set(plan.operations.map(operation => operation.harness));
    for (const entry of entries.values()) {
      if (!harnesses.has(entry.harness)) continue;
      let current: Sha256Digest | null;
      try {
        current = observed.has(entry.path) ? observed.get(entry.path)?.hash ?? null : await this.fs.hashOf(entry.path);
      } catch {
        current = null;
      }
      if (current !== entry.postimage) refuse('drifted', 'drifted', `${entry.path} changed since Khala last wrote it.`);
    }
    for (const operation of plan.operations) {
      if (operation.type === 'vendor_command') {
        if (!path.isAbsolute(operation.executable)) refuse('conflict', 'invalid_plan', 'Vendor commands need an absolute executable.', operation);
        for (const target of operation.writablePaths) {
          if (this.isInstallerOwned(target)) refuse('conflict', 'invalid_plan', `${target} is installer-owned.`, operation);
        }
        continue;
      }
      const entry = entries.get(operation.path);
      const current = observed.get(operation.path)?.hash ?? null;
      const expected = precondition(operation);
      if (entry !== undefined && expected !== entry.postimage) {
        refuse('drifted', 'drifted', `${operation.path} is managed and does not match the operation's precondition.`, operation);
      }
      if (current !== expected) {
        const unowned = entry === undefined && current !== null && expected === null;
        refuse(unowned ? 'conflict' : 'drifted', unowned ? 'unowned_target' : 'precondition_failed',
          `${operation.path} does not match the planned preimage.`, operation);
      }
      if (entry === undefined) {
        const removing = ['file_delete', 'file_restore', 'config_entry_remove'].includes(operation.type);
        if (removing) refuse('conflict', 'unowned_target', `${operation.path} is not Khala-managed; refusing to remove it.`, operation);
        if (this.isInstallerOwned(operation.path) && operation.type !== 'file_create') {
          refuse('conflict', 'unowned_target', `${operation.path} is an unowned installer path.`, operation);
        }
      } else {
        // Removal only ever returns a path to its original pre-Khala baseline.
        if (operation.type === 'file_restore' && operation.restored !== entry.baseline.hash) {
          refuse('conflict', 'baseline_mismatch', `${operation.path} would not be restored to its pre-Khala state.`, operation);
        }
        if (operation.type === 'file_delete' && entry.baseline.hash !== null) {
          refuse('conflict', 'baseline_mismatch', `${operation.path} existed before Khala; restore it instead of deleting it.`, operation);
        }
      }
      const post = postimage(operation);
      if (operation.type !== 'file_delete' && operation.type !== 'file_restore' && post !== null) {
        const bytes = plan.contents.get(post);
        if (bytes === undefined || sha256(bytes) !== post) refuse('conflict', 'missing_content', `No verified bytes for ${operation.path}.`, operation);
      }
    }
    return observed;
  }

  // --- apply ------------------------------------------------------------------

  modeFor(plan: ExecutablePlan, operation: SetupOperation, current: FileObservation | null, entry: ManifestEntry | undefined): number {
    if (this.isInstallerOwned(operation.path)) return plan.modes?.get(operation.path) ?? (operation.component === 'launcher' ? 0o500 : 0o400);
    return current?.mode ?? entry?.mode ?? 0o600;
  }

  async apply(plan: ExecutablePlan, manifest: SetupManifest | null, journal: Journal, index: number): Promise<void> {
    const entry = journal.operations[index]!;
    const { operation } = entry;
    const managed = new Map((manifest?.entries ?? []).map(item => [item.path, item]));
    entry.status = 'applying';
    for (const target of entry.targets) target.createdDirectories = await this.fs.missingDirectories(target.path);
    await this.writeJournal(journal);
    await this.boundary(`applying:${index}`);
    for (const target of entry.targets) await this.fs.createDirectories(target.createdDirectories);
    if (operation.type === 'vendor_command') {
      const { home, xdgConfigHome, xdgDataHome, xdgStateHome } = this.options.roots;
      await (this.options.runVendorCommand ?? runVendorCommand)(operation.executable, operation.args, {
        HOME: home, XDG_CONFIG_HOME: xdgConfigHome, XDG_DATA_HOME: xdgDataHome, XDG_STATE_HOME: xdgStateHome, PATH: this.options.searchPath,
      });
      for (const target of entry.targets) {
        target.postimage = await this.fs.hashOf(target.path);
        target.postimageKnown = true;
      }
      // Record the observed postimage at once, so a later recovery can prove what it reverses.
      await this.writeJournal(journal);
    } else {
      const [target] = entry.targets;
      const current = await this.fs.observe(operation.path);
      const post = postimage(operation);
      let mode: number | null = null;
      if (post === null) {
        await this.fs.remove(operation.path, precondition(operation)!);
      } else {
        const bytes = operation.type === 'file_restore'
          ? await this.readBackup(managed.get(operation.path)!.baseline.backup!, post)
          : plan.contents.get(post)!;
        mode = operation.type === 'file_restore'
          ? managed.get(operation.path)!.baseline.mode!
          : this.modeFor(plan, operation, current, managed.get(operation.path));
        await this.fs.replace(operation.path, precondition(operation), bytes, mode);
      }
      await this.fs.verify(operation.path, post, mode);
      if (post === null || operation.type === 'file_restore') {
        await this.fs.removeEmptyDirectories(managed.get(operation.path)?.createdDirectories ?? []);
      }
      target!.postimage = post;
    }
    await this.boundary(`applied:${index}`);
    entry.status = 'applied';
    await this.writeJournal(journal);
    await this.boundary(`recorded:${index}`);
  }

  /** The manifest after every operation applied. Existing entries keep their original baseline. */
  async nextManifest(plan: ExecutablePlan, manifest: SetupManifest | null, journal: Journal): Promise<SetupManifest | null> {
    const entries = new Map((manifest?.entries ?? []).map(entry => [entry.path, entry]));
    for (const { operation, targets } of journal.operations) {
      for (const target of targets) {
        const previous = entries.get(target.path);
        const post = target.postimage;
        const baseline = previous?.baseline ?? { hash: target.preimage, backup: target.backup, mode: target.mode };
        const released = operation.type === 'file_delete' || operation.type === 'file_restore'
          || post === null || post === baseline.hash;
        if (released) {
          entries.delete(target.path);
          continue;
        }
        const ownership: Ownership = this.isInstallerOwned(target.path) ? 'installer' : 'foreign';
        const observed = await this.fs.observe(target.path);
        entries.set(target.path, {
          path: target.path,
          harness: operation.harness,
          component: operation.component,
          ownership,
          operationId: operation.id,
          postimage: post,
          mode: observed!.mode,
          baseline,
          createdDirectories: previous?.createdDirectories ?? target.createdDirectories,
        });
      }
    }
    if (entries.size === 0) return null;
    return { v: 1, transaction: journal.id, planDigest: plan.planDigest, entries: sortEntries([...entries.values()]) };
  }

  // --- the transaction ------------------------------------------------------------

  async run(): Promise<ExecutionOutcome> {
    if (!(await this.acquireLock())) {
      return { kind: 'busy', diagnostics: [diagnostic('setup_busy', 'Another Khala setup or remove is running; retry after it finishes.')] };
    }
    try {
      const recovered = await this.recover();
      if (recovered !== null) return recovered;
      let manifest: SetupManifest | null;
      try {
        manifest = await this.readManifest();
      } catch (error) {
        if (error instanceof ManifestSchemaError && error.unsupportedVersion) {
          return { kind: 'refused', state: 'unsupported', diagnostics: [diagnostic('manifest_unsupported', 'The setup manifest uses an unsupported schema version.')] };
        }
        return { kind: 'recovery_required', operations: [], diagnostics: [diagnostic('manifest_corrupt', 'The setup manifest is unreadable.')] };
      }
      // With no journal left, backups the manifest does not reference (from a crash before
      // `prepared`, or after `journal_removed`) are unreferenced and safe to delete.
      await this.collectBackups(manifest);
      const plan = await this.options.replan(manifest);
      if (plan.planDigest !== this.options.confirmedDigest) return { kind: 'replanned', plan };
      let observed: Map<string, FileObservation | null>;
      try {
        observed = await this.validate(plan, manifest);
      } catch (error) {
        if (error instanceof Refusal) return { kind: 'refused', state: error.state, diagnostics: [error.diagnostic] };
        throw error;
      }
      if (plan.operations.length === 0) return { kind: 'committed', changed: false, plan, operations: [] };
      return await this.transact(plan, manifest, observed);
    } finally {
      await this.releaseLock();
    }
  }

  async transact(plan: ExecutablePlan, manifest: SetupManifest | null, observed: Map<string, FileObservation | null>): Promise<ExecutionOutcome> {
    const id = (this.options.transactionId ?? randomUUID)();
    if (!UUID.test(id)) throw new Error('transaction ids must be lowercase UUIDs');
    const journal: Journal = { v: JOURNAL_SCHEMA_VERSION, id, command: plan.command, planDigest: plan.planDigest, state: 'prepared', operations: [], manifest: null };
    try {
      let counter = 0;
      for (const operation of plan.operations) {
        const targets: JournalTarget[] = [];
        for (const target of targetPaths(operation)) {
          const current = observed.get(target) ?? null;
          let backup: string | null = null;
          if (current !== null) {
            backup = `${id}/${counter}`;
            counter += 1;
            const file = this.backupPath(backup);
            await this.fs.createDirectories(await this.fs.missingDirectories(file));
            await this.fs.replace(file, null, current.bytes, 0o600);
            await this.fs.verify(file, current.hash, 0o600);
          }
          const known = operation.type !== 'vendor_command';
          targets.push({
            path: target, preimage: current?.hash ?? null, mode: current?.mode ?? null, backup,
            postimage: known ? postimage(operation) : null, postimageKnown: known, createdDirectories: [],
          });
        }
        journal.operations.push({ operation, status: 'planned', targets });
      }
      await this.writeJournal(journal);
      await this.boundary('prepared');
    } catch (error) {
      // Nothing outside executor state has been touched yet.
      await this.fs.write(this.paths.journal, null).catch(() => undefined);
      await this.collectBackups(manifest).catch(() => undefined);
      return { kind: 'rolled_back', operations: report(null, plan.operations, () => 'planned'), diagnostics: [failure(error)] };
    }
    for (let index = 0; index < journal.operations.length; index += 1) {
      try {
        await this.apply(plan, manifest, journal, index);
      } catch (error) {
        return await this.rollback(journal, [failure(error, journal.operations[index]!.operation)], true);
      }
    }
    try {
      journal.manifest = await this.nextManifest(plan, manifest, journal);
      journal.state = 'committed';
      await this.writeJournal(journal);
      await this.boundary('committed');
    } catch (error) {
      return await this.rollback({ ...journal, state: 'prepared', manifest: null }, [failure(error)], true);
    }
    try {
      await this.finalize(journal);
    } catch (error) {
      // The transaction is committed; the next command finalizes the journal.
      return { kind: 'recovery_required', operations: report(journal, plan.operations, () => 'applied'), diagnostics: [failure(error)] };
    }
    return { kind: 'committed', changed: true, plan, operations: report(journal, plan.operations, () => 'applied') };
  }
}

function failure(error: unknown, operation?: SetupOperation): SetupDiagnostic {
  if (error instanceof SetupFilesystemError) {
    const code = error.code === 'precondition_failed' ? 'precondition_failed' : error.code === 'postimage_mismatch' ? 'postimage_mismatch' : 'apply_failed';
    return diagnostic(code, `${error.code} at ${error.target}.`, operation);
  }
  return diagnostic('apply_failed', 'A setup operation failed.', operation);
}

function lockPid(bytes: Uint8Array): number | null {
  return lockIdentity(bytes)?.pid ?? null;
}

function lockIdentity(bytes: Uint8Array): LockIdentity | null {
  try {
    const record = JSON.parse(new TextDecoder().decode(bytes)) as Rec;
    const pid = record.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
    return {
      pid,
      bootId: typeof record.bootId === 'string' ? record.bootId : null,
      startTime: typeof record.startTime === 'string' ? record.startTime : null,
    };
  } catch {
    return null;
  }
}

function processIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Applies a confirmed setup or remove plan transactionally. */
export async function executeSetupPlan(options: ExecuteOptions): Promise<ExecutionOutcome> {
  return await new Executor(options).run();
}

/**
 * Read-only journal inspection for `status`: `clean`, `recovery_required` for an
 * interrupted or unreadable transaction, or `unsupported` for a newer schema.
 */
export async function inspectSetupRecovery(roots: SetupRoots): Promise<'clean' | 'recovery_required' | 'unsupported'> {
  const executor = new Executor({ roots, searchPath: '', confirmedDigest: `sha256:${'0'.repeat(64)}`, replan: async () => { throw new Error('read-only'); } });
  let file: FileObservation | null;
  try {
    file = await executor.fs.observe(executor.paths.journal);
  } catch {
    return 'recovery_required';
  }
  if (file === null) return 'clean';
  try {
    decodeJournal(file.bytes);
  } catch (error) {
    return error instanceof JournalError && error.unsupportedVersion ? 'unsupported' : 'recovery_required';
  }
  return 'recovery_required';
}
