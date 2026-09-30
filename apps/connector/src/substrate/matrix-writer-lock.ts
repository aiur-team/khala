import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { link, open, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

type Owner = Readonly<{ v: 1; pid: number; start: string; token: string }>;
export type MatrixWriterLockDiagnostic = Readonly<{ kind: 'acquired' | 'stale_recovered' }>;

export class MatrixWriterLockError extends Error {
  constructor(readonly code: 'active_writer' | 'ownership_uncertain' | 'guard_unavailable') {
    super(`matrix_writer_lock_${code}`);
    this.name = 'MatrixWriterLockError';
  }
}

function lockFailure(error: unknown): MatrixWriterLockError {
  return error instanceof MatrixWriterLockError ? error : new MatrixWriterLockError('guard_unavailable');
}

// The kernel start tick distinguishes a reused PID from the original process.
// Unknown process identity is never evidence that a writer has died.
async function processStart(pid: number): Promise<string | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    return end < 0 ? null : stat.slice(end + 2).split(' ')[19] ?? null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new MatrixWriterLockError('ownership_uncertain');
  }
}

async function withGuard<T>(root: string, work: () => Promise<T>): Promise<T> {
  const guard = path.join(root, 'writer.guard');
  const file = await open(guard, 'a', 0o600).catch(error => { throw lockFailure(error); });
  await file.close();
  // This file is permanent. flock is released by the kernel on process death,
  // including a crash during recovery; removing the guard would split waiters
  // across different inodes.
  const child = spawn('flock', ['-x', guard, 'sh', '-c', 'printf "ready\\n"; cat >/dev/null'],
    { stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdin.on('error', () => undefined);
  const done = new Promise<void>(resolve => child.once('close', () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      child.stdout.once('data', data => {
        if (String(data) !== 'ready\n') reject(new MatrixWriterLockError('guard_unavailable'));
        else { ready = true; resolve(); }
      });
      child.once('error', () => reject(new MatrixWriterLockError('guard_unavailable')));
      child.once('exit', () => { if (!ready) reject(new MatrixWriterLockError('guard_unavailable')); });
    });
    return await work();
  } finally {
    child.stdin.end();
    await done;
  }
}

// The portable fallback keeps the original exclusive-create contract. Without
// Linux owner identity and the guard, an existing lock is never reclaimed.
async function acquireExclusive(root: string): Promise<Readonly<{
  diagnostic: MatrixWriterLockDiagnostic;
  close(): Promise<void>;
}>> {
  const lockPath = path.join(root, 'writer.lock');
  let handle;
  try { handle = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new MatrixWriterLockError('ownership_uncertain');
    throw new MatrixWriterLockError('guard_unavailable');
  }
  try { await handle.writeFile(String(process.pid)); }
  catch {
    try { await handle.close(); await rm(lockPath, { force: true }); } catch { /* Fail closed if cleanup fails. */ }
    throw new MatrixWriterLockError('guard_unavailable');
  }
  let closed = false;
  return {
    diagnostic: { kind: 'acquired' },
    async close() {
      if (closed) return;
      try { await handle.close(); await rm(lockPath, { force: true }); }
      catch (error) { throw lockFailure(error); }
      closed = true;
    },
  };
}

async function ownerState(lockPath: string): Promise<'absent' | 'active' | 'stale' | 'uncertain'> {
  let raw: string;
  try { raw = await readFile(lockPath, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw new MatrixWriterLockError('ownership_uncertain');
  }
  const legacyPid = /^\d+\n?$/u.test(raw) ? Number(raw.trim()) : null;
  let pid: number;
  let start: string | null = null;
  if (legacyPid !== null) pid = legacyPid;
  else {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return 'uncertain'; }
    if (typeof parsed !== 'object' || parsed === null || !('v' in parsed) || parsed.v !== 1
      || !('pid' in parsed) || !('start' in parsed) || !('token' in parsed)
      || typeof parsed.pid !== 'number' || typeof parsed.start !== 'string'
      || typeof parsed.token !== 'string' || !/^[0-9a-f-]{36}$/u.test(parsed.token)) return 'uncertain';
    pid = parsed.pid;
    start = parsed.start;
  }
  if (!Number.isSafeInteger(pid) || pid < 1) return 'uncertain';
  const current = await processStart(pid);
  if (current === null) return 'stale';
  return start === null || current === start ? 'active' : 'stale';
}

/** Only the fixed diagnostic crosses the substrate boundary; no owner path or PID is exposed. */
export async function acquireMatrixWriterLock(root: string, platform: NodeJS.Platform = process.platform): Promise<Readonly<{
  diagnostic: MatrixWriterLockDiagnostic;
  close(): Promise<void>;
}>> {
  if (platform !== 'linux') return acquireExclusive(root);
  const lockPath = path.join(root, 'writer.lock');
  const start = await processStart(process.pid);
  if (start === null) throw new MatrixWriterLockError('ownership_uncertain');
  const owner: Owner = { v: 1, pid: process.pid, start, token: randomUUID() };
  const temporary = path.join(root, `writer.${owner.token}.tmp`);
  let recovered = false;
  await withGuard(root, async () => {
    const state = await ownerState(lockPath);
    if (state === 'active') throw new MatrixWriterLockError('active_writer');
    if (state === 'uncertain') throw new MatrixWriterLockError('ownership_uncertain');
    if (state === 'stale') { await rm(lockPath); recovered = true; }
    try {
      await writeFile(temporary, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
      await link(temporary, lockPath);
    } finally { await rm(temporary, { force: true }); }
  }).catch(error => { throw lockFailure(error); });
  let closed = false;
  return {
    diagnostic: { kind: recovered ? 'stale_recovered' : 'acquired' },
    async close() {
      if (closed) return;
      await withGuard(root, async () => {
        const raw = await readFile(lockPath, 'utf8').catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        });
        if (raw !== JSON.stringify(owner)) throw new MatrixWriterLockError('ownership_uncertain');
        await rm(lockPath);
      }).catch(error => { throw lockFailure(error); });
      closed = true;
    },
  };
}
