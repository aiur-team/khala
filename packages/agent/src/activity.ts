import * as fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJsonAtomic, type SessionFiles } from './state';

export type Activity = { state: 'idle' | 'busy'; updatedAt: string };
export async function readActivity(files: SessionFiles): Promise<Activity> {
  const activity = await readJson<Activity>(path.join(files.dir, 'activity.json'));
  return activity && ['idle', 'busy'].includes(activity.state)
    && typeof activity.updatedAt === 'string' && Number.isFinite(Date.parse(activity.updatedAt))
    ? activity : { state: 'busy', updatedAt: new Date(0).toISOString() };
}
const USAGE_LIMIT = 'usage-limit.json';
/** A Claude StopFailure on a usage or rate limit; the MCP heartbeat shows the agent away while it exists. */
export async function markUsageLimit(files: SessionFiles, now: () => Date = () => new Date()): Promise<void> {
  await writeJsonAtomic(path.join(files.dir, USAGE_LIMIT), { at: now().toISOString() });
}
export async function clearUsageLimit(files: SessionFiles): Promise<void> {
  await fs.rm(path.join(files.dir, USAGE_LIMIT), { force: true });
}
export async function usageLimited(dir: string): Promise<boolean> {
  return (await readJson(path.join(dir, USAGE_LIMIT))) !== null;
}
export async function writeActivity(files: SessionFiles, state: Activity['state'], now: () => Date = () => new Date()): Promise<Activity> {
  const activity = { state, updatedAt: now().toISOString() };
  await writeJsonAtomic(path.join(files.dir, 'activity.json'), activity);
  return activity;
}
