import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { wakeLine } from './rules';
import { withWakeLock } from './lock';

export interface WakeAttempt { nonce: string; driver: string; at: number; deadline: number; activityUpdatedAt?: string | number }
export interface WakeDriverState { failures: number; disabled?: boolean; reason?: string; at?: string; noticeShown?: boolean }
export type WakeState = Record<string, WakeDriverState>;
export interface WakeSettlement { nonce: string; driver: string; status: 'success' | 'failure' | 'void' }
interface SessionData { attempts: WakeAttempt[]; state: WakeState }
async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error; }
}
async function atomic(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try { await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}
// Both hook and MCP use the same lock. State and attempts live in one atomic
// journal; wake-state.json is a status projection, never the source of truth.
async function locked<T>(dir: string, work: (data: SessionData) => T): Promise<T> {
  return withWakeLock(dir, 'wake.lock', async () => {
    const data = await readJson<SessionData>(path.join(dir, 'wake-journal.json'), { attempts: [], state: {} });
    const result = work(data);
    await atomic(path.join(dir, 'wake-journal.json'), data);
    await atomic(path.join(dir, 'wake-state.json'), data.state);
    return result;
  });
}
export async function readWakeState(dir: string): Promise<WakeState> {
  return (await readJson<SessionData>(path.join(dir, 'wake-journal.json'), { attempts: [], state: {} })).state;
}
export async function recordAttempt(dir: string, attempt: WakeAttempt): Promise<void> {
  wakeLine(attempt.nonce);
  if (!attempt.driver || ['__proto__', 'constructor', 'prototype'].includes(attempt.driver) || !Number.isFinite(attempt.at) || !Number.isFinite(attempt.deadline) || attempt.deadline <= attempt.at) throw new Error('invalid_wake_attempt');
  await locked(dir, data => {
    if (data.attempts.some(item => item.nonce === attempt.nonce)) throw new Error('duplicate_wake_nonce');
    data.attempts.push(attempt);
  });
}
export async function settleAttempts(dir: string, input: {
  now: number;
  activity: { state: string; updatedAt: string | number } | null;
  promptText?: string;
}): Promise<WakeSettlement[]> {
  // The atomic journal is authoritative. An attempt published after this read
  // remains pending for the next hook or poll; never overwrite it from this snapshot.
  const snapshot = await readJson<SessionData>(path.join(dir, 'wake-journal.json'), { attempts: [], state: {} });
  if (!snapshot.attempts.length) return [];
  return locked(dir, data => {
    const results: WakeSettlement[] = [];
    const remaining: WakeAttempt[] = [];
    const activityAt = typeof input.activity?.updatedAt === 'number' ? input.activity.updatedAt : Date.parse(input.activity?.updatedAt ?? '');
    for (const attempt of data.attempts) {
      let status: WakeSettlement['status'] | undefined;
      const baselineAt = typeof attempt.activityUpdatedAt === 'number' ? attempt.activityUpdatedAt : attempt.activityUpdatedAt === undefined ? attempt.at : Date.parse(attempt.activityUpdatedAt);
      const verified = input.promptText?.includes(`(k-${attempt.nonce})`);
      const activityChanged = input.activity && (input.activity.state !== 'idle' || activityAt > baselineAt);
      // Prompt integrations settle before writing their own busy boundary.
      // Any changed activity here therefore belongs to prior user activity.
      if (activityChanged) status = 'void';
      else if (verified && input.now <= attempt.deadline) status = 'success';
      else if (input.now >= attempt.deadline && input.activity?.state === 'idle') status = 'failure';
      else if (input.promptText !== undefined) status = 'void';
      if (!status) { remaining.push(attempt); continue; }
      results.push({ nonce: attempt.nonce, driver: attempt.driver, status });
      if (status === 'void') continue;
      const prior = data.state[attempt.driver] ?? { failures: 0 };
      if (status === 'success') data.state[attempt.driver] = { failures: 0 };
      else {
        const failures = prior.failures + 1;
        data.state[attempt.driver] = failures >= 2
          ? { failures, disabled: true, reason: 'nonce_timeout', at: new Date(input.now).toISOString() }
          : { failures };
      }
    }
    data.attempts = remaining;
    return results;
  });
}

/** Re-consent clears attempts as well as failures so an old deadline cannot disable again. */
export async function resetWakeDriver(dir: string, driver: string): Promise<void> {
  await locked(dir, data => {
    delete data.state[driver];
    data.attempts = data.attempts.filter(attempt => attempt.driver !== driver);
  });
}
/** Claim notice generations under the same lock as settlement and re-consent. */
export async function takeWakeDisableNotices(dir: string): Promise<string[]> {
  return locked(dir, data => {
    const drivers: string[] = [];
    for (const [driver, state] of Object.entries(data.state)) {
      if (!state.disabled || state.noticeShown) continue;
      state.noticeShown = true;
      drivers.push(driver);
    }
    return drivers;
  });
}
