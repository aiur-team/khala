import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkName } from '@khala/contracts/m1/names';
import { harnessInfo, type HarnessId } from '@khala/contracts/m1/harness';
import { readJson, StateError, stateRoot, writeJsonAtomic } from '../state';

export const HOSTED_PROFILE_FILE = 'hosted-profile.json';
export type HostedProfileFile = { v: 1; username: string; savedAt: string };
export const LOCAL_OWNER_FALLBACK_NAME = 'User';

export function defaultLocalAgentName(username: string, harness: HarnessId, n = 1): string {
  return `${username}-${harnessInfo(harness).modelName}${n === 1 ? '' : `-${n}`}`;
}
export function isDefaultLocalAgentName(name: string, username: string, harness: HarnessId): boolean {
  const escaped = defaultLocalAgentName(username, harness).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`^${escaped}(?:-\\d+)?$`, 'iu').test(name);
}
export function freeLocalAgentName(username: string, harness: HarnessId, taken: Iterable<string>): string {
  const used = new Set([...taken].map(name => name.toLowerCase()));
  let n = 1;
  while (n < 1000 && used.has(defaultLocalAgentName(username, harness, n).toLowerCase())) n++;
  return defaultLocalAgentName(username, harness, n);
}

export function hostedUsernameFromAgentName(displayName: string, harness: HarnessId): string | null {
  const suffix = new RegExp(`-${harnessInfo(harness).modelName}(?:-\\d+)?$`, 'iu');
  if (!suffix.test(displayName)) return null;
  const candidate = displayName.replace(suffix, '');
  const checked = checkName(candidate, 'username');
  return checked.ok && checked.name === candidate && isDefaultLocalAgentName(displayName, candidate, harness) ? candidate : null;
}

async function ensurePrivateRoot(root: string): Promise<void> {
  try {
    try { await fs.mkdir(root, { recursive: true, mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stat = await fs.lstat(root);
    // Windows has no POSIX mode bits; the profile ACL protects the directory.
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new StateError('unsafe_state_dir');
  } catch (error) {
    if (error instanceof StateError) throw error;
    throw new StateError('storage_failed');
  }
}

export async function saveHostedUsername(username: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const checked = checkName(username, 'username');
  if (!checked.ok || checked.name !== username) return;
  const root = stateRoot(env);
  await ensurePrivateRoot(root);
  const file = path.join(root, HOSTED_PROFILE_FILE);
  const existing = await readJson<Partial<HostedProfileFile>>(file).catch(() => null);
  if (existing?.v === 1 && existing.username === username) return;
  await writeJsonAtomic(file, { v: 1, username, savedAt: new Date().toISOString() } satisfies HostedProfileFile);
}

export async function resolveLocalOwnerName(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  try {
    const cached = await readJson<Partial<HostedProfileFile>>(path.join(stateRoot(env), HOSTED_PROFILE_FILE));
    if (cached?.v === 1) {
      const checked = checkName(cached.username, 'username');
      if (checked.ok && checked.name === cached.username) return checked.name;
    }
  } catch { /* An unavailable cache does not prevent local startup. */ }
  let raw = env.USER;
  if (raw === undefined) {
    try { raw = os.userInfo().username; } catch { raw = ''; }
  }
  const checked = checkName(raw, 'username');
  return checked.ok ? checked.name : LOCAL_OWNER_FALLBACK_NAME;
}
