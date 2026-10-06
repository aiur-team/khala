import type { Harness } from '@khala/contracts/m1/agent-join';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveStateDir } from '../src/state';
import { adapterFor } from '../src/harness';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const NOTICE = 'Khala: new channel messages. They arrive in the next hook context.\n';
export const DEADLINE_MS = 24 * 60 * 60 * 1000;
const POLL_MS = 500;
type IO = { stderr: Pick<NodeJS.WriteStream, 'write'>; env: NodeJS.ProcessEnv; now: () => Date };
async function readJson(file: string): Promise<{ nonce?: string; mode?: string; state?: string; updatedAt?: string; lastDeliveredEventId?: string | null; deliveredCount?: number } | null> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Match inbox unreadCount: ignore corrupt records and incomplete trailing writes. */
async function unreadChannelMessages(dir: string): Promise<number> {
  const cursor = await readJson(path.join(dir, 'cursor.json'));
  const delivered = cursor && (cursor.lastDeliveredEventId === null || typeof cursor.lastDeliveredEventId === 'string')
    && Number.isSafeInteger(cursor.deliveredCount) && typeof cursor.deliveredCount === 'number' && cursor.deliveredCount >= 0 ? cursor.deliveredCount : 0;
  let content: string;
  try { content = await fs.readFile(path.join(dir, 'inbox.jsonl'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  let index = 0, messages = 0;
  for (const line of content.split('\n').slice(0, -1)) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || !['eventId', 'roomId', 'ts', 'sender', 'senderLabel', 'body'].every(key => typeof entry[key] === 'string')
      || !['human', 'agent', 'unknown'].includes(entry.senderKind) || !['message', 'event'].includes(entry.kind)) continue;
    if (index++ >= delivered && entry.kind === 'message') messages++;
  }
  return messages;
}
/** Re-list each observation so channels joined while Stop is waiting are included. */
export async function unreadMessages(dir: string): Promise<number> {
  const directories = [dir];
  try {
    for (const entry of await fs.readdir(path.join(dir, 'channels'), { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) directories.push(path.join(dir, 'channels', entry.name));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let messages = 0;
  for (const directory of directories) {
    if ((await readJson(path.join(directory, 'mode.json')))?.mode === 'async') continue;
    messages += await unreadChannelMessages(directory);
  }
  return messages;
}
function testDuration(value: string | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}
function parentAlive(parent: number): boolean {
  if (process.ppid !== parent) return false;
  try { process.kill(parent, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return true; throw error; }
}

export async function watch(stdin: string, _argv: readonly string[], io: IO = { stderr: process.stderr, env: process.env, now: () => new Date() }): Promise<number> {
  let temporary: string | undefined;
  try {
    const parent = process.ppid;
    const input = JSON.parse(stdin);
    if (input?.hook_event_name !== 'Stop' || typeof input.session_id !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.session_id)) return 0;
    const dir = resolveStateDir(adapterFor('claude')!.id as Harness, input.session_id, io.env);
    if (!(await fs.stat(dir)).isDirectory()) return 0;
    const nonce = randomBytes(6).toString('hex');
    const owner = path.join(dir, 'watcher.json');
    temporary = path.join(dir, `.watcher-${nonce}.tmp`);
    const started = io.now();
    await fs.writeFile(temporary, JSON.stringify({ nonce, armedAt: started.toISOString() }) + '\n', { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, owner);
    temporary = undefined;
    const deadline = started.getTime() + testDuration(io.env.KHALA_WAKE_TEST_DEADLINE_MS, DEADLINE_MS);
    const poll = testDuration(io.env.KHALA_WAKE_TEST_POLL_MS, POLL_MS);
    const owns = async () => (await readJson(owner))?.nonce === nonce;
    const idle = async () => {
      const activity = await readJson(path.join(dir, 'activity.json'));
      return activity?.state === 'idle' && typeof activity.updatedAt === 'string' && Number.isFinite(Date.parse(activity.updatedAt));
    };
    while (io.now().getTime() < deadline) {
      if (!await owns() || !parentAlive(parent)) return 0;
      if (await idle() && await unreadMessages(dir) > 0) {
        // Delivery or a new prompt may have raced the first observation.
        if (await unreadMessages(dir) > 0 && await idle() && await owns()
          && parentAlive(parent) && io.now().getTime() < deadline) {
          io.stderr.write(NOTICE);
          return 2;
        }
      }
      await sleep(Math.min(poll, Math.max(0, deadline - io.now().getTime())));
    }
  } catch { /* A watcher error must never become a wake prompt. */ }
  finally { if (temporary) { try { await fs.unlink(temporary); } catch { /* Best effort. */ } } }
  return 0;
}
export default async function run(stdin: string, argv: readonly string[]): Promise<number> {
  return watch(stdin, argv);
}
