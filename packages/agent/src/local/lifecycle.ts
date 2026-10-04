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

async function healthy(fetchImpl: typeof fetch, file: HelperFile): Promise<boolean> {
  try {
    const response = await fetchImpl(`${file.origin}/healthz`, { signal: AbortSignal.timeout(500) });
    if (response.status !== 200) {
      await response.body?.cancel();
      return false;
    }
    const body: unknown = await response.json();
    return typeof body === 'object' && body !== null && 'ok' in body && body.ok === true
      && 'pid' in body && body.pid === file.pid;
  } catch { return false; }
}
function connection(file: HelperFile): HelperConnection {
  return { origin: file.origin, adminToken: file.adminToken };
}

async function attempt(env: NodeJS.ProcessEnv, deps: EnsureHelperDeps): Promise<HelperConnection> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const spawn = deps.spawn ?? ((command, argv, options) => nodeSpawn(command, [...argv], options));
  const sleep = deps.sleep ?? sleepDefault;
  const now = deps.now ?? Date.now;
  const existing = await readHelperFile(env);
  if (existing && await healthy(fetchImpl, existing)) return connection(existing);

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
        detached: true, stdio: ['ignore', fd, fd], env: helperChildEnv(env), cwd: paths.root, shell: false,
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

export function ensureHelper(env: NodeJS.ProcessEnv = process.env, deps: EnsureHelperDeps = {}): Promise<HelperConnection> {
  const key = helperPaths(env).helperFile;
  const pending = attempts.get(key);
  if (pending) return pending;
  const promise = attempt(env, deps).finally(() => { attempts.delete(key); });
  attempts.set(key, promise);
  return promise;
}
