// The Executor's durable record of the CLI session it started for a ticket, read
// from Aiur's per-ticket `.agent_events.jsonl`. Only a structured
// `native_session` payload counts; issue comments, workpads and agent prose never
// do. When the log carries no such record the session stays unknown and the
// verdict stays `unproven`.

import fs from 'node:fs';
import path from 'node:path';
import type { AiurPort, NativeSession } from '../types';

function field(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null;
}

/** One `native_session` payload, strictly: every field present and well formed. */
export function decodeNativeSession(value: unknown): NativeSession | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const pid = record.os_pid;
  const strings = ['session_id', 'harness', 'provider', 'model', 'cli_version', 'launch_command', 'started_at'].map(key => field(record, key));
  if (!Number.isSafeInteger(pid) || (pid as number) <= 1 || strings.some(entry => entry === null)) return null;
  const [sessionId, harness, provider, model, cliVersion, launchCommand, startedAt] = strings as string[];
  return { sessionId: sessionId!, pid: pid as number, harness: harness!, provider: provider!, model: model!, cliVersion: cliVersion!, launchCommand: launchCommand!, startedAt: startedAt! };
}

/** The single native session in one ticket log; two different sessions are ambiguous and prove nothing. */
export function nativeSessionFromLog(text: string): NativeSession | null {
  const sessions = new Map<string, NativeSession>();
  for (const line of text.split('\n')) {
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    const payload = (entry as { payload?: unknown } | null)?.payload;
    const session = decodeNativeSession((payload as { native_session?: unknown } | null)?.native_session);
    if (session) sessions.set(`${session.sessionId}\0${session.pid}`, session);
  }
  return sessions.size === 1 ? [...sessions.values()][0]! : null;
}

function repositoryKey(repository: string): string {
  return Buffer.from(`${repository}`).toString('base64url');
}

/** Newest run directory's log for the ticket, under `<logsRoot>/<run>/log/`. */
export function ticketLog(logsRoot: string, repository: string, ticket: number): string | null {
  let runs: string[];
  try { runs = fs.readdirSync(logsRoot).sort().reverse(); } catch { return null; }
  const name = `github-${repositoryKey(repository)}.${ticket}.agent_events.jsonl`;
  for (const run of runs) {
    const file = path.join(logsRoot, run, 'log', name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/** Signal 0 checks existence without delivering anything; `/proc` confirms the harness still runs there. */
export function processRuns(pid: number, harness: string): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').some(part => path.basename(part).includes(harness));
  } catch {
    return false;
  }
}

export function aiurLogs(logsRoot: string, repository: string): AiurPort {
  return {
    async session(ticket) {
      const file = ticketLog(logsRoot, repository, ticket);
      return file ? nativeSessionFromLog(fs.readFileSync(file, 'utf8')) : null;
    },
    async alive(session) {
      return processRuns(session.pid, session.harness);
    },
  };
}
