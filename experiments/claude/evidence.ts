import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Redacts personal paths and common credential shapes before anything is published.
export function sanitize(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[redacted-key]')
    .replace(/(Authorization:\s*Bearer\s+)\S+/gi, '$1[redacted]')
    .replace(/\b(token|secret|password|api[_-]?key)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1$2[redacted]')
    .replace(/\/home\/[^/\s"']+/g, '~')
    .replace(/\/Users\/[^/\s"']+/g, '~')
    .replace(/[A-Za-z]:\\Users\\[^\\\s"']+/g, '~');
}

export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

export type CommandReport = {
  command: string;
  status: 'exit' | 'deadline' | 'error';
  exitCode: number | null;
  stdoutSha256: string;
  stdoutHead: string;
  durationMs: number;
};

// Runs one read-only inspection command with a hard deadline; the child is killed, not abandoned.
export function inspectCommand(binary: string, arg: string, deadlineMs: number): Promise<CommandReport> {
  const started = performance.now();
  return new Promise(resolve => {
    const child = spawn(binary, [arg], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let settled = false;
    let timedOut = false;
    const finish = (status: CommandReport['status'], exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command: `claude ${arg}`,
        status,
        exitCode,
        stdoutSha256: sha256(stdout),
        stdoutHead: sanitize(stdout.split('\n').slice(0, 3).join('\n')).slice(0, 400),
        durationMs: Math.round(performance.now() - started),
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, deadlineMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.once('error', () => finish('error', null));
    child.once('close', code => finish(timedOut ? 'deadline' : 'exit', timedOut ? null : code));
  });
}

export type Inventory = { platform: string; node: string; commands: CommandReport[]; version: string };

// U1 inventory: only `--version` and `--help`; never a command that touches a session.
export async function collectInventory(deadlineMs: number, binary = 'claude'): Promise<Inventory> {
  const commands = [await inspectCommand(binary, '--version', deadlineMs), await inspectCommand(binary, '--help', deadlineMs)];
  const version = commands[0].status === 'exit' ? commands[0].stdoutHead.trim().split(/\s/)[0] ?? 'unobserved' : 'unobserved';
  return { platform: `${process.platform}-${process.arch}`, node: process.version, commands, version };
}

// Claude Code stores a session transcript at ~/.claude/projects/<cwd with non-alphanumerics as '-'>/<id>.jsonl.
export const projectDir = (workdir: string, home = homedir()): string =>
  join(home, '.claude', 'projects', workdir.replace(/[^A-Za-z0-9]/g, '-'));

export type TranscriptEntry = {
  type?: string; sessionId?: string; cwd?: string; version?: string; permissionMode?: string; message?: { model?: string };
  operation?: string; timestamp?: string; content?: unknown; origin?: { kind?: string };
};

export type QueueFate = { line: number; content: string; timestamp?: string; cleared: { line: number; operation: 'dequeue' | 'remove'; timestamp?: string } | null };

// Replays the transcript's FIFO queue log: `dequeue` starts a new turn with the head item, while `remove`
// drops an item already injected into a running turn (as a `queued_command` attachment).
export function replayQueue(entries: readonly { line: number; entry: TranscriptEntry }[]): QueueFate[] {
  const fates: QueueFate[] = [];
  const pending: QueueFate[] = [];
  for (const { line, entry } of entries) {
    if (entry.type !== 'queue-operation') continue;
    const content = String(entry.content ?? '');
    if (entry.operation === 'enqueue') {
      const fate: QueueFate = { line, content, timestamp: entry.timestamp, cleared: null };
      fates.push(fate);
      pending.push(fate);
    } else if (entry.operation === 'dequeue' || entry.operation === 'remove') {
      const index = entry.operation === 'remove' ? pending.findIndex(item => item.content === content) : 0;
      const item = index >= 0 ? pending.splice(index, 1)[0] : undefined;
      if (item) item.cleared = { line, operation: entry.operation, timestamp: entry.timestamp };
    }
  }
  return fates;
}

// Entries the designated transcript gained from a 1-based line onward; the native queue is only visible here.
export async function transcriptEntriesFrom(workdir: string, sessionId: string, fromLine: number, home = homedir()): Promise<{ line: number; entry: TranscriptEntry }[]> {
  const raw = await readFile(join(projectDir(workdir, home), `${sessionId}.jsonl`), 'utf8');
  return raw.split('\n').filter(Boolean).map((text, index) => ({ line: index + 1, entry: JSON.parse(text) as TranscriptEntry })).filter(item => item.line >= fromLine);
}

export type TranscriptSnapshot = {
  lines: number;
  sha256: string;
  sessionIds: string[];
  cwds: string[];
  versions: string[];
  permissionModes: string[];
  models: string[];
  siblingTranscripts: number;
};

// Reads only the designated session's transcript and counts (never opens) sibling transcripts in its project dir.
export async function snapshotTranscript(workdir: string, sessionId: string, home = homedir()): Promise<TranscriptSnapshot> {
  const dir = projectDir(workdir, home);
  const raw = await readFile(join(dir, `${sessionId}.jsonl`), 'utf8');
  const entries = raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as TranscriptEntry);
  const distinct = (pick: (entry: TranscriptEntry) => string | undefined) =>
    [...new Set(entries.map(pick).filter((value): value is string => typeof value === 'string' && value !== '<synthetic>'))];
  const files = (await readdir(dir)).filter(name => name.endsWith('.jsonl'));
  return {
    lines: entries.length,
    sha256: sha256(raw),
    sessionIds: distinct(entry => entry.sessionId),
    cwds: distinct(entry => entry.cwd),
    versions: distinct(entry => entry.version),
    permissionModes: distinct(entry => entry.permissionMode),
    models: distinct(entry => entry.message?.model),
    siblingTranscripts: files.filter(name => name !== `${sessionId}.jsonl`).length,
  };
}
