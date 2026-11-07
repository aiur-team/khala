import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { latestWorkspaceSession } from './mcp/startup-sessions';
import { ensureStateDir, readJson, SESSION_ID_PATTERN, StateError, stateKey, stateRoot, writeJsonAtomic } from './state';
import { nearestNonShellAncestor, readProcess, type ProcessInfo, type ProcessReader } from './harness/proc';

/**
 * A Claude agent belongs to the folder its session was started in, not to one conversation:
 * any session started there (new, resumed, /clear, another account) is the same agent.
 * The folder is Claude's project dir, which Claude exports to both its MCP servers and its hooks.
 * Without it (an older Claude) the session id stays the agent id, as before. An invalid session id
 * is returned unchanged so callers keep rejecting it.
 */
export async function claudeAgentId(env: NodeJS.ProcessEnv, sessionId: string): Promise<string> {
  const folder = env.CLAUDE_PROJECT_DIR;
  return folder && path.isAbsolute(folder) && SESSION_ID_PATTERN.test(sessionId) ? folderAgentId(env, folder) : sessionId;
}

/**
 * The agent id for `folder`, pinned the first time the folder is seen. A folder that already has
 * per-session state (before agents were keyed by folder) adopts its newest session in place, so that
 * agent keeps its identity, rejoin secret and crypto store. Otherwise the id is derived from the folder.
 */
export async function folderAgentId(env: NodeJS.ProcessEnv, folder: string): Promise<string> {
  let real: string;
  try { real = await fs.realpath(folder); } catch { real = path.resolve(folder); }
  const dir = path.join(stateRoot(env), 'claude', '.by-folder');
  const file = path.join(dir, `${stateKey(real)}.json`);
  await ensureStateDir(dir);
  const pinned = async () => {
    const saved = await readJson<{ agentId?: unknown }>(file);
    return typeof saved?.agentId === 'string' && SESSION_ID_PATTERN.test(saved.agentId) ? saved.agentId : undefined;
  };
  const existing = await pinned();
  if (existing) return existing;
  const agentId = await latestWorkspaceSession('claude', env, [...new Set([path.resolve(folder), real])]) ?? `folder-${stateKey(real)}`;
  // link() creates the pin only if absent, so concurrent first runs (a hook and MCP) agree on one id.
  const temporary = path.join(dir, `.${randomUUID()}.tmp`);
  try {
    await writeJsonAtomic(temporary, { agentId, folder: real });
    await fs.link(temporary, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error instanceof StateError ? error : new StateError('storage_failed');
    return await pinned() ?? agentId;
  } finally { await fs.unlink(temporary).catch(() => {}); }
  return agentId;
}

type Proc = { pid: number; startTime: string };
/** The MCP process that holds the agent's connection, and the harness (Claude) process that runs it. */
export type AgentOwner = Proc & { harness?: Proc };
const ownerFile = (dir: string) => path.join(dir, 'owner.json');
const releasedFile = (dir: string) => path.join(dir, 'released.json');
const same = (a: Proc | undefined, b: Proc | null | undefined) => !!a && !!b && a.pid === b.pid && a.startTime === b.startTime;
async function alive(proc: Proc | undefined, read: ProcessReader): Promise<boolean> {
  return !!proc && Number.isSafeInteger(proc.pid) && proc.pid > 0 && same(proc, await read(proc.pid));
}
async function self(read: ProcessReader): Promise<{ me: ProcessInfo; harness: ProcessInfo | null } | null> {
  const me = await read(process.pid);
  return me ? { me, harness: await nearestNonShellAncestor(process.pid, read) } : null;
}

/**
 * The newest session in a folder takes over its agent: claim it, then wait (bounded) until the previous
 * live owner has closed its connection, so one crypto store and one Matrix member serve the folder.
 */
export async function claimAgent(dir: string, options: { read?: ProcessReader; timeoutMs?: number } = {}): Promise<void> {
  const read = options.read ?? readProcess;
  const current = await self(read);
  if (!current) return;
  const previous = await readJson<AgentOwner>(ownerFile(dir));
  const owner: AgentOwner = { pid: current.me.pid, startTime: current.me.startTime,
    ...(current.harness ? { harness: { pid: current.harness.pid, startTime: current.harness.startTime } } : {}) };
  await writeJsonAtomic(ownerFile(dir), owner);
  if (!previous || same(previous, current.me)) return;
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  while (Date.now() < deadline && await alive(previous, read) && !same(previous, await readJson<Proc>(releasedFile(dir)))) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

/** Written by a superseded owner once its connection is closed. */
export async function markReleased(dir: string, read: ProcessReader = readProcess): Promise<void> {
  const me = await read(process.pid);
  if (me) await writeJsonAtomic(releasedFile(dir), { pid: me.pid, startTime: me.startTime });
}

/** True once another live process has claimed this agent. */
export async function supersededHere(dir: string, read: ProcessReader = readProcess): Promise<boolean> {
  const owner = await readJson<AgentOwner>(ownerFile(dir));
  return !!owner && owner.pid !== process.pid && await alive(owner, read);
}

/**
 * Hooks and watchers route to the live owner only: true when the owning harness process is alive and is
 * not the harness this process runs under. Unreadable processes (sandboxes) never suppress delivery.
 */
export async function supersededHarness(dir: string, pid: number = process.pid, read: ProcessReader = readProcess): Promise<boolean> {
  // ponytail: Windows process reads spawn PowerShell, too slow for every hook; there both sessions' hooks deliver.
  if (process.platform === 'win32' && read === readProcess) return false;
  const owner = await readJson<AgentOwner>(ownerFile(dir));
  if (!owner?.harness || !await alive(owner.harness, read)) return false;
  const harness = await nearestNonShellAncestor(pid, read);
  return !!harness && !same(owner.harness, harness);
}
