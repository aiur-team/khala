import type { HarnessId } from '@khala/contracts/m1/harness';
import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { SESSION_ID_PATTERN, ensureStateDir, readJson, stateRoot, writeJsonAtomic } from '../state';
import { walkAncestors, nearestNonShellAncestor, readProcess, type ProcessReader } from './proc';

export type SessionContext = { harness: HarnessId; pid?: number; readProcess?: ProcessReader };
export type SessionSource = Readonly<{
  kind: 'meta' | 'env' | 'hook-map' | 'workspace' | 'process';
  resolve(meta: Readonly<Record<string, unknown>> | undefined, env: NodeJS.ProcessEnv, context: SessionContext): unknown | Promise<unknown>;
  rejoinable(sessionId: string): boolean;
}>;
export type ResolvedSession = { sessionId: string; rejoinable: boolean };
export const SESSION_UNKNOWN_HINT = 'Send the agent one message first, then retry.';
type HookMapping = { sessionId: string; startTime: string; at: string; workspace?: string };
const mappingDir = (harness: HarnessId, env: NodeJS.ProcessEnv) => path.join(stateRoot(env), harness, '.by-pid');

export async function recordHookSession(harness: HarnessId, sessionId: string, env: NodeJS.ProcessEnv,
  options: { pid?: number; readProcess?: ProcessReader; now?: () => Date; workspace?: string } = {}): Promise<void> {
  if (!SESSION_ID_PATTERN.test(sessionId)) return;
  const parent = await nearestNonShellAncestor(options.pid ?? process.pid, options.readProcess ?? readProcess);
  if (!parent) return;
  const dir = mappingDir(harness, env);
  await ensureStateDir(dir);
  const file = path.join(dir, `${parent.pid}.json`);
  const at = (options.now ?? (() => new Date()))().toISOString();
  const previous = await readJson<HookMapping>(file);
  if (previous?.startTime === parent.startTime && typeof previous.at === 'string' && previous.at > at) return;
  await writeJsonAtomic(file, { sessionId, startTime: parent.startTime, at,
    ...(options.workspace !== undefined ? { workspace: options.workspace } : {}) } satisfies HookMapping);
}

export const hookMapSource: SessionSource = {
  kind: 'hook-map', rejoinable: () => true,
  async resolve(_meta, env, context) {
    const dir = mappingDir(context.harness, env);
    // Reads use the same safety checks as writes; a missing entry is an ordinary miss.
    try { await lstat(dir); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    await ensureStateDir(dir);
    // Match the writer's boundary: a nested harness must never inherit an outer session.
    const parent = await nearestNonShellAncestor(context.pid ?? process.pid, context.readProcess ?? readProcess);
    if (!parent) return null;
    const entry = await readJson<HookMapping>(path.join(dir, `${parent.pid}.json`));
    if (entry?.startTime === parent.startTime && typeof entry.sessionId === 'string'
      && SESSION_ID_PATTERN.test(entry.sessionId) && typeof entry.at === 'string' && Number.isFinite(Date.parse(entry.at))) return entry.sessionId;
    return null;
  },
};
export const processSource: SessionSource = {
  kind: 'process', rejoinable: () => false,
  async resolve(_meta, _env, context) {
    for await (const parent of walkAncestors(context.pid ?? process.pid, context.readProcess ?? readProcess)) {
      return `proc-${parent.pid}-${parent.startTime}`;
    }
    return null;
  },
};

/** A present but invalid value owns precedence; validation must not fall through. */
export async function resolveSources(sources: readonly SessionSource[], meta: Readonly<Record<string, unknown>> | undefined,
  env: NodeJS.ProcessEnv, context: SessionContext): Promise<ResolvedSession | null> {
  for (const source of sources) {
    const value = await source.resolve(meta, env, context);
    if (value === undefined || value === null) continue;
    return typeof value === 'string' && SESSION_ID_PATTERN.test(value)
      ? { sessionId: value, rejoinable: source.rejoinable(value) } : null;
  }
  return null;
}
