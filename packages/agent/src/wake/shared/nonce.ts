import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { wakeLine } from './rules';

export interface WakeAttempt { nonce: string; driver: string; at: number; deadline: number; activityUpdatedAt?: string | number }
export interface WakeDriverState { failures: number; disabled?: boolean; reason?: string; at?: string }
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
async function clearAbandonedLock(lock: string): Promise<void> {
  let entries: string[];
  try { entries = await fs.readdir(lock); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    const owner = /^owner-(\d+)-[a-f0-9]{16}$/.exec(entry);
    if (!owner) continue;
    try { process.kill(Number(owner[1]), 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue;
      // Delete only the observed generation. A replacement lock's owner has
      // a different filename, so competing reclaimers cannot remove it.
      await fs.rm(path.join(lock, entry), { force: true });
    }
  }
  // Acquisition publishes a populated directory atomically. rmdir therefore
  // cannot delete a successor, even if another process reclaimed this lock.
  try { await fs.rmdir(lock); }
  catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
}
// Both hook and MCP use the same lock. State and attempts live in one atomic
// journal; wake-state.json is a status projection, never the source of truth.
async function locked<T>(dir: string, work: (data: SessionData) => T): Promise<T> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, 'wake.lock');
  const owner = `owner-${process.pid}-${randomBytes(8).toString('hex')}`;
  const candidate = path.join(dir, `.${owner}`);
  await fs.mkdir(candidate, { mode: 0o700 });
  await fs.writeFile(path.join(candidate, owner), '', { mode: 0o600 });
  let acquired = false;
  try {
    for (let tries = 0; tries < 200; tries++) {
      try { await fs.rename(candidate, lock); acquired = true; break; }
      catch (error) { if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
      await clearAbandonedLock(lock);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  } finally {
    if (!acquired) await fs.rm(candidate, { recursive: true, force: true });
  }
  if (!acquired) throw new Error('wake_state_locked');
  try {
    const data = await readJson<SessionData>(path.join(dir, 'wake-journal.json'), { attempts: [], state: {} });
    const result = work(data);
    await atomic(path.join(dir, 'wake-journal.json'), data);
    await atomic(path.join(dir, 'wake-state.json'), data.state);
    return result;
  } finally {
    await fs.rm(path.join(lock, owner), { force: true });
    try { await fs.rmdir(lock); }
    catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  }
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

/** Cancel only the attempt whose transport was skipped; preserve concurrent wakes. */
export async function cancelAttempt(dir: string, nonce: string): Promise<void> {
  await locked(dir, data => { data.attempts = data.attempts.filter(attempt => attempt.nonce !== nonce); });
}

/** A transport inserted text but could not safely submit it. Settle only its nonce. */
export async function failAttempt(dir: string, nonce: string, now: number): Promise<void> {
  await locked(dir, data => {
    const attempt = data.attempts.find(item => item.nonce === nonce);
    if (!attempt) return;
    data.attempts = data.attempts.filter(item => item.nonce !== nonce);
    const failures = (data.state[attempt.driver]?.failures ?? 0) + 1;
    data.state[attempt.driver] = failures >= 2
      ? { failures, disabled: true, reason: 'nonce_timeout', at: new Date(now).toISOString() }
      : { failures };
  });
}
