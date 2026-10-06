import { createInterface } from 'node:readline';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cursorPaths } from '../install/cursor';
import { readActivity } from '../activity';
import { monitorArmed, monitorOwner } from '../watch';
import { monitorStorageCandidates } from '../monitor-storage';
import { readJson, writeJsonAtomic, type SessionFiles } from '../state';
import { wakeLine, settleAttempts } from './shared';
import type { WakeDriver } from './driver';

export const MUSE_WAKE_REQUEST = 'muse-monitor-wake.json';
export type MuseWakeRequest = { owner: string; line: string; at: number; deadline: number; journalOffset: number };
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function museCliPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const { prefix } = cursorPaths({ platform: process.platform, path, home, env });
  return process.platform === 'win32' ? path.join(prefix, 'khala.cmd') : path.join(prefix, 'bin', 'khala');
}
export function museWatchCommand(sessionId?: string, bin = museCliPath()): string {
  return `${shellQuote(bin)} watch --harness muse --session ${shellQuote(sessionId ?? '<current session id from khala_status>')}`;
}
export function museMonitorInstruction(sessionId?: string, command = museWatchCommand(sessionId)): string {
  return `start Muse's monitor tool with command ${JSON.stringify(command)}, persistent: true, wake_delay_ms: 0, show_lines: true. Always pass the current session id explicitly; the monitor shell does not inherit MUSE_SESSION_ID. Keep one monitor per session; If it prints "Do not re-arm", report the reason and do not restart it. Notifications are wake notices; use khala_read for channel content. Never run the watcher as a foreground shell command.`;
}

/** The agent arms the native monitor; this driver supplies its sparse stdout events. */
export function createMuseMonitorDriver(): WakeDriver {
  return {
    id: 'monitor', rung: 1, optIn: false, minIdleMs: 0, deadlineMs: 30_000, verification: 'nonce', startsActivity: true,
    available: ctx => monitorArmed(ctx.files),
    unavailableReason: () => 'monitor_missing',
    async verify(ctx) {
      const proof = await museWakeProof(ctx.files, ctx.sessionId, ctx.env);
      if (proof) await settleAttempts(ctx.files.dir, { now: ctx.now, activity: null,
        promptText: proof.text, verifiedAt: proof.at });
    },
    async wake(ctx, line) {
      const nonce = /\(k-([a-f0-9]{8})\)$/.exec(line)?.[1];
      if (!nonce || wakeLine(nonce) !== line) throw new TypeError('invalid_monitor_wake_line');
      if (ctx.signal.aborted || (await readActivity(ctx.files)).state !== 'idle' || !await monitorArmed(ctx.files)) return 'skipped';
      const epoch = (await readActivity(ctx.files)).updatedAt;
      for (const dir of monitorStorageCandidates(ctx.files)) {
        if ((await readJson<{ epoch: string }>(path.join(dir, 'monitor-wake-observed.json')))?.epoch === epoch) return 'skipped';
      }
      const owner = await monitorOwner(ctx.files);
      if (!owner) return 'skipped';
      const journal = museJournalPath(ctx.sessionId, ctx.env);
      let journalOffset = 0;
      if (journal) {
        try { journalOffset = (await fs.stat(journal)).size; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      await writeJsonAtomic(path.join(ctx.files.dir, MUSE_WAKE_REQUEST), {
        owner: owner.nonce, line, at: ctx.now, deadline: ctx.now + 30_000, journalOffset,
      } satisfies MuseWakeRequest);
    },
  };
}

/** Muse UUIDv7 session ids encode the creation date used by its journal layout. */
export function museJournalPath(sessionId: string, env: NodeJS.ProcessEnv): string | undefined {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(sessionId)) return undefined;
  // Muse buckets journals by the process's local calendar date, not UTC.
  const created = new Date(Number.parseInt(sessionId.replaceAll('-', '').slice(0, 12), 16));
  const date = [String(created.getFullYear()), String(created.getMonth() + 1).padStart(2, '0'), String(created.getDate()).padStart(2, '0')];
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const data = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, '.local', 'share');
  return path.join(data, 'muse', 'sessions', ...date, sessionId, 'session.jsonl');
}

/** Only a drained monitor event in this Stop's run proves model ingress. */
export async function museStopWakeText(stdin: string, files: SessionFiles, env: NodeJS.ProcessEnv): Promise<{ text: string; at: number } | undefined> {
  const input = JSON.parse(stdin);
  if (input.hook_event_name !== 'Stop' || typeof input.turn_id !== 'string') return undefined;
  return museWakeProof(files, input.session_id, env, input.turn_id);
}

async function museWakeProof(files: SessionFiles, sessionId: string, env: NodeJS.ProcessEnv,
  turnId?: string): Promise<{ text: string; at: number } | undefined> {
  const request = await readJson<MuseWakeRequest>(path.join(files.dir, MUSE_WAKE_REQUEST));
  if (!request) return undefined;
  const journal = museJournalPath(sessionId, env);
  if (!journal) return undefined;
  if (!Number.isSafeInteger(request.journalOffset) || request.journalOffset < 0) return undefined;
  let handle: fs.FileHandle;
  try { handle = await fs.open(journal, 'r'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  const stream = handle.createReadStream({ start: request.journalOffset, encoding: 'utf8', autoClose: false });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const event = record.payload?.event;
      if (record.stream?.id === sessionId && record.payload_type === 'runtime.session'
        && typeof record.payload?.run_id === 'string' && (turnId === undefined || record.payload.run_id === turnId)
        && event?.kind === 'inbox_item_drained'
        && event.drain_target_run_stream?.id === record.payload.run_id
        && event.delivery_snapshot?.source?.source === 'monitor_event'
        && event.delivery_snapshot.source.event_kind === 'stdout_line'
        && event.delivery_snapshot.body === request.line
        && record.recorded_at / 1000 >= request.at && record.recorded_at / 1000 <= request.deadline) return { text: request.line, at: record.recorded_at / 1000 };
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  finally { reader.close(); stream.destroy(); await handle.close(); }
  return undefined;
}
