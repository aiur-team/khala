// Executor-owned native CLI fixture evidence. This private record is written by
// the capture command, never by an Aiur daemon log or an acceptance ticket.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertCommand } from '../guard';
import type { AiurPort, NativeSession, RoleName } from '../types';

const RUN = /^[0-9a-f]{12}$/;
const HARNESSES = new Set(['claude', 'codex', 'opencode']);
const PROVIDERS: Record<string, readonly string[]> = { claude: ['anthropic'], codex: ['openai'], opencode: ['deepseek', 'anthropic', 'openai'] };

export type ProcessSnapshot = Readonly<{
  pid: number; executable: string; argv: readonly string[]; processStartTicks: string; bootId: string; tty: string;
}>;

function verifiedPane(pane: string, tty: string): boolean {
  try {
    const argv = ['tmux', 'display-message', '-p', '-t', pane, '#{pane_tty}'];
    assertCommand(argv, null);
    return execFileSync(argv[0]!, argv.slice(1), { encoding: 'utf8', timeout: 2_000 }).trim() === tty;
  } catch { return false; }
}

function nativeCommand(session: NativeSession): boolean {
  const name = (value: string) => path.basename(value).replace(/\.(?:c?m?js)$/, '');
  const command = name(session.argv[0]!);
  const direct = command === session.harness;
  const nodeScript = /^(?:node|bun|deno)$/.test(command) && session.argv.length > 1 && name(session.argv[1]!) === session.harness;
  const model = session.argv.some((arg, index) =>
    ((arg === '--model' || arg === '-m') && session.argv[index + 1] === session.model)
    || arg === `--model=${session.model}`);
  return (direct || nodeScript) && model;
}

/** Linux process identity; start ticks and boot ID rule out PID reuse. */
export function observeProcess(pid: number): ProcessSnapshot | null {
  try {
    if (!Number.isSafeInteger(pid) || pid <= 1) return null;
    const proc = `/proc/${pid}`;
    const stat = fs.readFileSync(`${proc}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const tty = fs.readlinkSync(`${proc}/fd/0`);
    const argv = fs.readFileSync(`${proc}/cmdline`, 'utf8').split('\0').filter(Boolean);
    const executable = fs.readlinkSync(`${proc}/exe`);
    const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    if (!/\/dev\/(pts\/\d+|tty\d*)$/.test(tty) || !argv.length || !/^[0-9]+$/.test(fields[19] ?? '')) return null;
    return { pid, executable, argv, processStartTicks: fields[19]!, bootId, tty };
  } catch { return null; }
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value);
}

/** Only an exact, fully scoped Executor observation can become evidence. */
export function decodeNativeSession(value: unknown): NativeSession | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (r.source !== 'executor-native-tmux-fixture' || r.repository !== 'aiur-team/khala'
    || !validText(r.runId) || !RUN.test(r.runId) || !Number.isSafeInteger(r.ticket) || (r.ticket as number) <= 0
    || (r.role !== 'a' && r.role !== 'b') || !validText(r.sessionId) || !validText(r.harness)
    || !HARNESSES.has(r.harness) || !validText(r.provider) || !PROVIDERS[r.harness]?.includes(r.provider) || !validText(r.model)
    || !validText(r.cliVersion) || !validText(r.versionOutput) || !r.versionOutput.includes(r.cliVersion)
    || !validText(r.tmuxPane) || !/^%[0-9]+$/.test(r.tmuxPane)
    || !validText(r.capturedAt) || !Number.isFinite(Date.parse(r.capturedAt))
    || !validText(r.startedAt) || !Number.isFinite(Date.parse(r.startedAt))
    || Date.parse(r.startedAt) > Date.parse(r.capturedAt as string)
    || !Number.isSafeInteger(r.pid) || (r.pid as number) <= 1 || !validText(r.processStartTicks)
    || !/^[0-9]+$/.test(r.processStartTicks) || !validText(r.bootId) || !validText(r.executable)
    || !validText(r.tty) || !Array.isArray(r.argv) || r.argv.length === 0 || r.argv.length > 64
    || !r.argv.every(validText) || r.argv.some((arg: string) => /(?:app-server|khala\s+run)/.test(arg))) return null;
  return {
    repository: r.repository, runId: r.runId, ticket: r.ticket as number, role: r.role,
    sessionId: r.sessionId, harness: r.harness, provider: r.provider, model: r.model,
    cliVersion: r.cliVersion, startedAt: r.startedAt, capturedAt: r.capturedAt, pid: r.pid as number,
    processStartTicks: r.processStartTicks, bootId: r.bootId, executable: r.executable,
    tty: r.tty, tmuxPane: r.tmuxPane, argv: r.argv as string[], launchCommand: (r.argv as string[]).join(' '),
  };
}

export function sameProcess(session: NativeSession, observed: ProcessSnapshot | null): boolean {
  return observed !== null && session.pid === observed.pid && session.executable === observed.executable
    && session.processStartTicks === observed.processStartTicks && session.bootId === observed.bootId
    && session.tty === observed.tty && JSON.stringify(session.argv) === JSON.stringify(observed.argv);
}

function recordDir(root: string, repository: string, runId: string): string {
  return path.join(root, Buffer.from(repository).toString('base64url'), runId);
}

function recordPath(root: string, repository: string, runId: string, ticket: number, role: RoleName): string {
  return path.join(recordDir(root, repository, runId), `${ticket}-${role}.json`);
}

/** Capture from a trusted Executor harness observation, cross-checking live /proc. */
export function captureNativeSession(
  root: string, value: unknown, observe = observeProcess, paneIsTty = verifiedPane, now = Date.now,
): NativeSession {
  const captured = value && typeof value === 'object' ? { ...value, capturedAt: new Date(now()).toISOString() } : value;
  const session = decodeNativeSession(captured);
  if (!session || !sameProcess(session, observe(session.pid))) throw new Error('native fixture observation is incomplete or disagrees with the live process');
  if (!nativeCommand(session)) throw new Error('native harness and explicit model flag are absent from exact launch argv');
  if (!paneIsTty((captured as { tmuxPane: string }).tmuxPane, session.tty)) throw new Error('native process does not use the recorded tmux pane TTY');
  const directory = recordDir(root, session.repository, session.runId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const file = recordPath(root, session.repository, session.runId, session.ticket, session.role);
  const finalRecord = { ...(captured as Record<string, unknown>), capturedAt: new Date(now()).toISOString() };
  const finalSession = decodeNativeSession(finalRecord);
  if (!finalSession) throw new Error('native fixture observation changed during capture');
  fs.writeFileSync(file, JSON.stringify(finalRecord), { flag: 'wx', mode: 0o600 });
  return finalSession;
}

/** Exact run/ticket/role lookup; a second participant makes the record ambiguous. */
export function aiurRecords(root: string, repository: string, observe = observeProcess, paneIsTty = verifiedPane): AiurPort {
  return {
    async session(ticket, runId, role) {
      if (!RUN.test(runId) || (role !== 'a' && role !== 'b')) return null;
      const file = recordPath(root, repository, runId, ticket, role);
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.uid !== process.getuid?.()) return null;
        const session = decodeNativeSession(JSON.parse(fs.readFileSync(file, 'utf8')));
        if (!session || session.repository !== repository || session.runId !== runId || session.ticket !== ticket || session.role !== role) return null;
        if (!sameProcess(session, observe(session.pid)) || !paneIsTty(session.tmuxPane, session.tty)) return null;
        const other = role === 'a' ? 'b' : 'a';
        const sibling = recordPath(root, repository, runId, ticket, other);
        if (fs.existsSync(sibling)) return null;
        return session;
      } catch { return null; }
    },
    async alive(session) { return sameProcess(session, observe(session.pid)) && paneIsTty(session.tmuxPane, session.tty); },
  };
}
