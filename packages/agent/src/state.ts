import { isHarnessId } from '@khala/contracts/m1/harness';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { type AgentCredentials, type Harness } from '@khala/contracts/m1/agent-join';
import { readProcess, type ProcessReader } from './harness/proc';

export type AgentState = 'idle' | 'joining' | 'connected' | 'send_failed' | 'disconnected';
/** `displayName` is the agent's own current name in the channel; hooks show it as `you=`. */
export type StatusFile = { heartbeatAt?: string; owner?: { pid: number; startTime: string }; state: AgentState; channelName?: string; displayName?: string; detail?: string; updatedAt: string };
export type JoinFile = { joinId: string; pollSecret: string; confirmUrl: string; expiresAt: string; link: string };
export type SessionFiles = { dir: string; join: string; session: string; inbox: string; cursor: string; status: string; mode: string };
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export class StateError extends Error {
  readonly code: 'invalid_session_id' | 'unsafe_state_dir' | 'storage_failed';
  constructor(code: StateError['code']) {
    super(code);
    this.name = 'StateError';
    this.code = code;
  }
}

const WINDOWS = process.platform === 'win32';

/**
 * On Windows a rename over a file another process (a hook, the MCP server) is reading fails
 * with EPERM/EACCES/EBUSY until that reader closes it; retry briefly. POSIX renames once.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(from, to); return; } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!WINDOWS || attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) throw error;
      await new Promise(resolve => setTimeout(resolve, 10 + attempt * 5));
    }
  }
}

export function stateRoot(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME)
    // Windows: the profile directory, never a HOME that Git Bash may export for some processes only.
    ? env.XDG_STATE_HOME : path.join(WINDOWS ? os.homedir() : env.HOME ?? os.homedir(), '.local', 'state');
  return path.join(base, 'khala');
}
export function filesForDir(dir: string): SessionFiles {
  return { dir, mode: path.join(dir, 'mode.json'), join: path.join(dir, 'join.json'), session: path.join(dir, 'session.json'), inbox: path.join(dir, 'inbox.jsonl'), cursor: path.join(dir, 'cursor.json'), status: path.join(dir, 'status.json') };
}
/** Keys are shared by room directories and pending joins; never use raw Matrix IDs in paths. */
export function stateKey(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 24); }
export function channelsDir(files: SessionFiles): string { return path.join(files.dir, 'channels'); }
export function channelFiles(files: SessionFiles, roomId: string): SessionFiles {
  return filesForDir(path.join(channelsDir(files), stateKey(roomId)));
}
export function joinFilePath(files: SessionFiles, key: string): string {
  if (!/^[a-f0-9]{24}$/.test(key)) throw new StateError('storage_failed');
  return path.join(files.dir, 'joins', `${key}.json`);
}
export async function writeJoinFile(files: SessionFiles, link: string, join: JoinFile): Promise<void> {
  const file = joinFilePath(files, stateKey(link));
  await ensureStateDir(path.dirname(file));
  await writeJsonAtomic(file, join);
}
export async function readJoinFile(files: SessionFiles, link: string): Promise<JoinFile | null> {
  const file = joinFilePath(files, stateKey(link));
  await ensureStateDir(path.dirname(file));
  return readJson(file);
}
export async function removeJoinFile(files: SessionFiles, link: string): Promise<void> {
  const file = joinFilePath(files, stateKey(link));
  await ensureStateDir(path.dirname(file));
  try { await fs.unlink(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new StateError('storage_failed');
  }
}
export function sessionFiles(harness: Harness, sessionId: string, env?: NodeJS.ProcessEnv): SessionFiles {
  if (!isHarnessId(harness) || !SESSION_ID_PATTERN.test(sessionId)) throw new StateError('invalid_session_id');
  return filesForDir(path.join(stateRoot(env), harness, sessionId));
}
export function resolveStateDir(harness: Harness, sessionId: string, env?: NodeJS.ProcessEnv): string {
  return sessionFiles(harness, sessionId, env).dir;
}
export async function ensureStateDir(dir: string): Promise<void> {
  try {
    // Check parents before descending so a pre-existing symlink is never followed.
    let sessionDir = dir;
    if (path.basename(path.dirname(dir)) === 'channels' && /^[a-f0-9]{24}$/.test(path.basename(dir))
      && isHarnessId(path.basename(path.dirname(path.dirname(path.dirname(dir)))))
      && path.basename(path.dirname(path.dirname(path.dirname(path.dirname(dir))))) === 'khala') {
      sessionDir = path.dirname(path.dirname(dir));
    } else if (['channels', 'joins'].includes(path.basename(dir))
      && isHarnessId(path.basename(path.dirname(path.dirname(dir))))
      && path.basename(path.dirname(path.dirname(path.dirname(dir)))) === 'khala') {
      sessionDir = path.dirname(dir);
    }
    const directories = [path.dirname(path.dirname(sessionDir)), path.dirname(sessionDir), sessionDir];
    const relative = path.relative(sessionDir, dir);
    let parent = sessionDir;
    for (const component of relative ? relative.split(path.sep) : []) {
      parent = path.join(parent, component);
      directories.push(parent);
    }
    for (const directory of directories) {
      try { await fs.mkdir(directory, { recursive: true, mode: 0o700 }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const stat = await fs.lstat(directory);
      // Windows has no POSIX mode bits (directories report 0o777); the profile ACL protects it.
      if (!stat.isDirectory() || stat.isSymbolicLink() || (!WINDOWS && (stat.mode & 0o077) !== 0)
        || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new StateError('unsafe_state_dir');
    }
  } catch (error) {
    if (error instanceof StateError) throw error;
    throw new StateError('storage_failed');
  }
}
export async function openSessionDir(harness: Harness, sessionId: string, env?: NodeJS.ProcessEnv): Promise<SessionFiles> {
  const files = sessionFiles(harness, sessionId, env);
  await ensureStateDir(files.dir);
  return files;
}
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const dir = path.dirname(file);
  const temporary = path.join(dir, `.${path.basename(file)}-${randomUUID()}.tmp`);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(JSON.stringify(value) + '\n', 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameWithRetry(temporary, file);
    // Windows cannot fsync a directory handle; NTFS journals the rename itself.
    if (!WINDOWS) {
      const directory = await fs.open(dir, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } catch {
    throw new StateError('storage_failed');
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
  }
}
export async function readJson<T>(file: string): Promise<T | null> {
  let content: string;
  try { content = await fs.readFile(file, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new StateError('storage_failed');
  }
  try { return JSON.parse(content) as T; } catch { return null; }
}
export async function saveJoin(files: SessionFiles, join: JoinFile): Promise<void> { await writeJsonAtomic(files.join, join); }
export function readJoin(files: SessionFiles): Promise<JoinFile | null> { return readJson(files.join); }
export async function saveSession(files: SessionFiles, credentials: AgentCredentials): Promise<void> { await writeJsonAtomic(files.session, credentials); }
export async function removeSession(files: SessionFiles): Promise<void> { await removeStateFile(files.dir, 'session.json'); }
export async function writeStatus(files: SessionFiles, state: AgentState, detail?: string, now: () => Date = () => new Date(), channelName?: string, displayName?: string): Promise<StatusFile> {
  const status: StatusFile = { state, ...(channelName ? { channelName } : {}), ...(displayName ? { displayName } : {}), ...(detail ? { detail } : {}), updatedAt: now().toISOString() };
  if (['connected', 'send_failed'].includes(state)) status.heartbeatAt = status.updatedAt;
  const snapshot = await ownStatus(status);
  await writeJsonAtomic(files.status, snapshot);
  return snapshot;
}
let processIdentity: ReturnType<typeof readProcess> | undefined;
async function ownStatus<T>(value: T): Promise<T> {
  if (!value || typeof value !== 'object' || !('state' in value) || !['connected', 'send_failed'].includes(String(value.state))) return value;
  const owner = await (processIdentity ??= readProcess(process.pid));
  return owner ? { ...value, owner: { pid: owner.pid, startTime: owner.startTime } } : value;
}
/** Status files are snapshots. A dead or reused writer PID cannot report a live connection. */
export async function readStatus(files: SessionFiles, read: ProcessReader = readProcess): Promise<StatusFile | null> {
  const status = await readJson<StatusFile>(files.status);
  if (!status || !['connected', 'send_failed'].includes(status.state)) return status;
  const owner = status.owner;
  const writer = owner && Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.startTime === 'string'
    ? await read(owner.pid) : null;
  return writer && writer.startTime === owner?.startTime ? status
    : { ...status, state: 'disconnected', detail: 'process_exited' };
}
/** A sandbox may not see the MCP PID. A heartbeat is authoritative when present. */
export async function readWatcherStatus(files: SessionFiles, read: ProcessReader = readProcess, now: () => Date = () => new Date()): Promise<StatusFile | null> {
  const status = await readJson<StatusFile>(files.status);
  if (!status || !['connected', 'send_failed'].includes(status.state)) return status;
  if (status.heartbeatAt !== undefined) {
    const age = now().getTime() - Date.parse(status.heartbeatAt);
    return Number.isFinite(age) && age >= 0 && age < 60_000 ? status
      : { ...status, state: 'disconnected', detail: 'heartbeat_stale' };
  }
  const owner = status.owner;
  const writer = owner && Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.startTime === 'string'
    ? await read(owner.pid) : null;
  // Invisible owners are not evidence of death in a separate PID namespace.
  return writer && writer.startTime !== owner?.startTime
    ? { ...status, state: 'disconnected', detail: 'process_exited' } : status;
}
export async function writeStateFile(dir: string, name: 'join.json' | 'session.json' | 'cursor.json' | 'status.json' | 'mode.json' | 'rejoin.json' | 'channel.json' | 'resume.json', value: unknown): Promise<void> {
  if (!['join.json', 'session.json', 'cursor.json', 'status.json', 'mode.json', 'rejoin.json', 'channel.json', 'resume.json'].includes(name)) throw new StateError('storage_failed');
  await writeJsonAtomic(path.join(dir, name), name === 'status.json' ? await ownStatus(value) : value);
}
export function readStateFile<T>(dir: string, name: string): Promise<T | null> {
  if (!/^[a-z]+\.json$/.test(name)) throw new StateError('storage_failed');
  return readJson(path.join(dir, name));
}
export async function removeStateFile(dir: string, name: string): Promise<void> {
  if (!/^[a-z]+\.json$/.test(name) && name !== 'inbox.jsonl') throw new StateError('storage_failed');
  try { await fs.unlink(path.join(dir, name)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new StateError('storage_failed');
  }
}

export const TERMINAL_SESSION_DETAILS = ['left', 'removed', 'revoked', 'unauthorized', 'channel_deleted'] as const;
