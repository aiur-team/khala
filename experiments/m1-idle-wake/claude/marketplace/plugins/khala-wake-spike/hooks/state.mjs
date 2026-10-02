import { randomBytes } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
export const stateRoot = () => path.join(path.isAbsolute(process.env.XDG_STATE_HOME ?? '') ? process.env.XDG_STATE_HOME : path.join(homedir(), '.local/state'), 'khala');
export function stateDir(harness, session) {
  if (!validId(session) || !validId(harness)) throw new Error('Invalid harness or session id');
  return path.join(stateRoot(), harness, session);
}
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const readJson = async (file, fallback) => JSON.parse(await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return JSON.stringify(fallback); throw error; }));
export async function atomic(file, value) {
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temp, JSON.stringify(value) + '\n', { mode: 0o600 });
  await rename(temp, file);
}
export async function append(file, value) {
  await appendFile(file, JSON.stringify(value) + '\n', { mode: 0o600 });
  await chmod(file, 0o600);
}
export async function init(harness, session, channel) {
  const dir = stateDir(harness, session);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  // Refuse to reset an existing inbox or delivery cursor.
  await writeFile(path.join(dir, 'inbox.jsonl'), '', { flag: 'wx', mode: 0o600 });
  await atomic(path.join(dir, 'cursor.json'), { lastDeliveredEventId: null, deliveredCount: 0 });
  await atomic(path.join(dir, 'status.json'), { state: 'connected', channelName: channel, updatedAt: new Date().toISOString() });
  await atomic(path.join(dir, 'activity.json'), { state: 'busy', updatedAt: new Date().toISOString() });
  return dir;
}
export async function inbox(dir) {
  const lines = (await readFile(path.join(dir, 'inbox.jsonl'), 'utf8')).split('\n');
  // Ignore an incomplete trailing append until its terminating newline arrives.
  lines.pop();
  return lines.filter(Boolean).map(line => JSON.parse(line));
}
export async function unread(dir) {
  const lines = await inbox(dir);
  const cursor = await readJson(path.join(dir, 'cursor.json'), { deliveredCount: 0 });
  return { lines, messages: lines.slice(cursor.deliveredCount).filter(entry => entry.kind === 'message') };
}
