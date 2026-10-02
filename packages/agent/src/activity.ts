import path from 'node:path';
import { readJson, writeJsonAtomic, type SessionFiles } from './state';

export type Activity = { state: 'idle' | 'busy'; updatedAt: string };
export async function readActivity(files: SessionFiles): Promise<Activity> {
  const activity = await readJson<Activity>(path.join(files.dir, 'activity.json'));
  return activity && ['idle', 'busy'].includes(activity.state)
    && typeof activity.updatedAt === 'string' && Number.isFinite(Date.parse(activity.updatedAt))
    ? activity : { state: 'busy', updatedAt: new Date(0).toISOString() };
}
export async function writeActivity(files: SessionFiles, state: Activity['state'], now: () => Date = () => new Date()): Promise<Activity> {
  const activity = { state, updatedAt: now().toISOString() };
  await writeJsonAtomic(path.join(files.dir, 'activity.json'), activity);
  return activity;
}
