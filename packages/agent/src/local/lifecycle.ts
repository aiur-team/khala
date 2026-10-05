import * as fs from 'node:fs/promises';
import { close as closeFd } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleepDefault } from 'node:timers/promises';
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { LOCAL_DEFAULT_PORT, decodeHelperFile, type HelperFile } from '@khala/contracts/m1/local';
import { ensureStateDir, readJson, stateRoot, StateError } from '../state';
import { KhalaClientError } from '../client';
import { bundle } from '../bundle';
import { KHALA_AGENT_VERSION } from '../version';

export type HelperPaths = { root: string; helperFile: string; logFile: string; port: number; origin: string };
export function helperPaths(env: NodeJS.ProcessEnv = process.env): HelperPaths {
  const root = path.join(stateRoot(env), 'local');
  const candidate = /^\d{1,5}$/u.test(env.KHALA_LOCAL_PORT ?? '') ? Number(env.KHALA_LOCAL_PORT) : 0;
  const port = candidate >= 1 && candidate <= 65535 ? candidate : LOCAL_DEFAULT_PORT;
  return { root, helperFile: path.join(root, 'helper.json'), logFile: path.join(root, 'helper.log'), port, origin: `http://127.0.0.1:${port}` };
}

export async function readHelperFile(env: NodeJS.ProcessEnv = process.env): Promise<HelperFile | null> {
  const decoded = decodeHelperFile(await readJson<unknown>(helperPaths(env).helperFile));
  if (!decoded.ok) return null;
  const file = decoded.value;
  if (!Number.isSafeInteger(file.pid) || file.pid <= 0 || !Number.isSafeInteger(file.port)
    || file.port <= 0 || file.port > 65535 || file.origin !== `http://127.0.0.1:${file.port}`
    || !/^[A-Za-z0-9_-]{43}$/u.test(file.adminToken)) return null;
  return file;
}

export function helperBinPath(): string {
  // Bundled chunks sit flat beside dist/khala.mjs; source runs through bin/khala.mjs.
  return fileURLToPath(bundle ? new URL('./khala.mjs', import.meta.url) : new URL('../../bin/khala.mjs', import.meta.url));
}

export const HELPER_ENV_ALLOWLIST: readonly string[] = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'XDG_STATE_HOME', 'NODE_OPTIONS', 'KHALA_EGRESS_LOG',
  'KHALA_LOCAL_PORT', 'KHALA_LOCAL_IDLE_MS', 'KHALA_LOCAL_WEB_DIR',
];
export function helperChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of HELPER_ENV_ALLOWLIST) if (env[key] !== undefined) childEnv[key] = env[key];
  return childEnv;
}

export type EnsureHelperDeps = {
  fetch?: typeof fetch;
  spawn?: (command: string, argv: readonly string[], options: SpawnOptions) => { unref(): void; on(event: 'error', listener: (error: Error) => void): unknown };
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  openLog?: (file: string) => Promise<number>;
};
type HelperConnection = { origin: string; adminToken: string };
const attempts = new Map<string, Promise<HelperConnection>>();
let restarted = false;
const recovering = new Map<string, string>();

export function olderHelperVersion(version: unknown): boolean {
  if (typeof version !== 'string') return true;
  const parse = (value: string) => /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value);
  const helper = parse(version), cli = parse(KHALA_AGENT_VERSION);
  if (!helper || !cli) return true;
  for (let i = 1; i <= 3; i++) {
    if (Number(helper[i]) !== Number(cli[i])) return Number(helper[i]) < Number(cli[i]);
  }
  if (helper[4] === cli[4]) return false;
  if (!helper[4] || !cli[4]) return Boolean(helper[4]);
  const a = helper[4].split('.'), b = cli[4].split('.');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    if (a[i] === undefined || b[i] === undefined) return a[i] === undefined;
    const an = /^\d+$/u.test(a[i]!), bn = /^\d+$/u.test(b[i]!);
    if (an && bn) return Number(a[i]) < Number(b[i]);
    if (an !== bn) return an;
    return a[i]! < b[i]!;
  }
  return false;
}

async function healthy(fetchImpl: typeof fetch, file: HelperFile): Promise<{ version?: unknown } | null> {
  try {
    const response = await fetchImpl(`${file.origin}/healthz`, { signal: AbortSignal.timeout(500) });
    if (response.status !== 200) {
      await response.body?.cancel();
      return null;
    }
    const body: unknown = await response.json();
    return typeof body === 'object' && body !== null && 'ok' in body && body.ok === true
      && 'pid' in body && body.pid === file.pid ? { version: 'version' in body ? body.version : undefined } : null;
  } catch { return null; }
}
function connection(file: HelperFile): HelperConnection {
  return { origin: file.origin, adminToken: file.adminToken };
}

async function attempt(env: NodeJS.ProcessEnv, deps: EnsureHelperDeps, restartOrigin?: string): Promise<HelperConnection> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const spawn = deps.spawn ?? ((command, argv, options) => nodeSpawn(command, [...argv], options));
  const sleep = deps.sleep ?? sleepDefault;
  const now = deps.now ?? Date.now;
  const existing = await readHelperFile(env);
  const status = existing ? await healthy(fetchImpl, existing) : null;
  if (existing && status) {
    if ((!olderHelperVersion(status.version) && restartOrigin === undefined) || restarted) return connection(existing);
    // Never shut down an unrelated helper just because a loopback join rejected a harness.
    if (restartOrigin !== undefined && existing.origin !== restartOrigin) return connection(existing);
    restarted = true;
    recovering.set(helperPaths(env).helperFile, existing.origin);
    try {
      const response = await fetchImpl(`${existing.origin}/api/local/shutdown`, {
        method: 'POST', headers: { authorization: `Bearer ${existing.adminToken}` }, signal: AbortSignal.timeout(2000),
      });
      await response.body?.cancel();
      if (response.status !== 204) throw new Error('shutdown_failed');
      const deadline = now() + 2000;
      for (let i = 0; i < 20; i++) {
        if (!await healthy(fetchImpl, existing)) break;
        if (now() >= deadline || i === 19) throw new Error('shutdown_timeout');
        await sleep(100);
      }
    } catch { throw new KhalaClientError('internal_error', 'helper_unavailable'); }
  }

  const paths = helperPaths(env);
  try {
    // The state validator must inspect Khala-owned levels, not XDG_STATE_HOME.
    await ensureStateDir(path.join(paths.root, 'channels'));
    let handle: fs.FileHandle | undefined;
    let fd: number | undefined;
    let spawnFailed = false;
    try {
      if (deps.openLog) fd = await deps.openLog(paths.logFile);
      else {
        handle = await fs.open(paths.logFile, 'a', 0o600);
        await handle.chmod(0o600);
        fd = handle.fd;
      }
      const child = spawn(process.execPath, [helperBinPath(), 'local', 'serve'], {
        detached: true, stdio: ['ignore', fd, fd],
        env: helperChildEnv(existing && status ? { ...env, KHALA_LOCAL_PORT: String(existing.port) } : env), cwd: paths.root, shell: false,
      });
      child.on('error', () => { spawnFailed = true; });
      child.unref();
    } finally {
      if (handle) await handle.close();
      else if (fd !== undefined) {
        const descriptor = fd;
        await new Promise<void>(resolve => { closeFd(descriptor, () => resolve()); });
      }
    }

    const deadline = now() + 5000;
    while (!spawnFailed && now() < deadline) {
      const file = await readHelperFile(env);
      if (file && await healthy(fetchImpl, file) && !spawnFailed && now() <= deadline) return connection(file);
      if (spawnFailed || now() >= deadline) break;
      await sleep(100);
    }
  } catch (error) {
    if (error instanceof StateError) throw error;
  }
  throw new KhalaClientError('internal_error', 'helper_unavailable');
}

export function ensureHelper(env: NodeJS.ProcessEnv = process.env, deps: EnsureHelperDeps = {}, restartOrigin?: string): Promise<HelperConnection> {
  const key = helperPaths(env).helperFile;
  const pending = attempts.get(key);
  if (pending) return pending;
  const promise = attempt(env, deps, restartOrigin).finally(() => { attempts.delete(key); recovering.delete(key); });
  attempts.set(key, promise);
  return promise;
}

/** Share the version probe's restart allowance with invalid_harness recovery. */
export async function restartHelper(origin: string, env: NodeJS.ProcessEnv = process.env, deps: EnsureHelperDeps = {}): Promise<boolean> {
  const key = helperPaths(env).helperFile;
  const pending = attempts.get(key);
  if (pending) {
    const shareRecovery = !restarted || recovering.get(key) === origin;
    const connection = await pending;
    if (shareRecovery && restarted && connection.origin === origin) return true;
  }
  if (restarted) return false;
  const file = await readHelperFile(env);
  if (!file || file.origin !== origin) return false;
  await ensureHelper(env, deps, origin);
  return restarted;
}
