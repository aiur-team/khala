// Executor-owned native CLI fixture evidence. This private record is written by
// the capture command, never by an Aiur daemon log or an acceptance ticket.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
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

function tmux(argv: string[]): string {
  const command = ['tmux', ...argv];
  assertCommand(command, null);
  return execFileSync(command[0]!, command.slice(1), { encoding: 'utf8', timeout: 2_000 });
}

/** Read only the exact native pane; the fixture operator opens Claude/Codex /status first. */
function nativeStatus(session: NativeSession): string | null {
  try {
    return tmux(['capture-pane', '-p', '-t', session.tmuxPane]);
  } catch { /* An unavailable pane is unproven. */ }
  return null;
}

function codexSessionId(status: string | null): string | null {
  if (!status) return null;
  const ids = [...status.matchAll(/\bSession:\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi)];
  return ids.length === 1 ? ids[0]![1]!.toLowerCase() : null;
}

function codexStatusMatchesProfile(status: string | null, session: NativeSession): boolean {
  if (!status) return false;
  const model = status.match(/\bModel:\s+([^\n(│]+)/)?.[1]?.trim().toLowerCase();
  const provider = status.match(/\bModel provider:\s+([a-z]+)\b/)?.[1];
  return model === session.model.toLowerCase() && provider === session.provider;
}

/** Query the kernel's executable link for this PID, not argv[0] or PATH. */
function nativeVersion(session: NativeSession): string | null {
  try {
    const argv = [`/proc/${session.pid}/exe`, '--version'];
    assertCommand(argv, null);
    return execFileSync(argv[0]!, argv.slice(1), { encoding: 'utf8', timeout: 2_000, maxBuffer: 512 });
  } catch { return null; }
}

function parsedVersion(harness: NativeSession['harness'], output: string | null): string | null {
  const patterns: Record<string, RegExp> = {
    codex: /^codex-cli ([0-9]+\.[0-9]+\.[0-9]+)\n?$/,
    claude: /^([0-9]+\.[0-9]+\.[0-9]+) \(Claude Code\)\n?$/,
    opencode: /^([0-9]+\.[0-9]+\.[0-9]+)\n?$/,
  };
  return patterns[harness]?.exec(output ?? '')?.[1] ?? null;
}

function nativeCommand(session: NativeSession): boolean {
  const name = (value: string) => path.basename(value).replace(/\.(?:c?m?js)$/, '');
  const command = name(session.argv[0]!);
  const direct = command === session.harness
    || (session.harness === 'claude' && /^\d+\.\d+\.\d+$/.test(command)
      && session.executable === session.argv[0]
      && /\/claude\/versions\/\d+\.\d+\.\d+$/.test(session.executable));
  const nodeScript = /^(?:node|bun|deno)$/.test(command) && session.argv.length > 1 && name(session.argv[1]!) === session.harness;
  const model = session.argv.some((arg, index) =>
    ((arg === '--model' || arg === '-m') && session.argv[index + 1] === session.model)
    || arg === `--model=${session.model}`);
  return (direct || nodeScript) && model;
}

type NativeIdentity = Readonly<{ sessionId: string; provider: string; model: string; method: string }>;

function claudeIdentity(screen: string | null, expectedModel: string): NativeIdentity | null {
  if (!screen || !/^\s*Session kind:\s+interactive\s*$/m.test(screen)
    || !/^\s*Login method:\s+Claude Max account\s*$/m.test(screen)) return null;
  const ids = [...screen.matchAll(/^\s*Session ID:\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/gmi)];
  const models = [...screen.matchAll(/^\s*Model:\s+(\S+)\s+\((claude-[a-z0-9-]+)\)\s*$/gmi)];
  if (ids.length !== 1 || models.length !== 1
    || (expectedModel !== models[0]![1] && expectedModel !== models[0]![2])) return null;
  return { sessionId: ids[0]![1]!.toLowerCase(), provider: 'anthropic',
    model: expectedModel, method: 'claude-status-image-v1' };
}

function processEnvironment(pid: number, name: string): string | null {
  try {
    const items = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
    const found = items.filter(item => item.startsWith(`${name}=`));
    return found.length === 1 ? found[0]!.slice(name.length + 1) : null;
  } catch { return null; }
}

/** OpenCode's native pane title identifies its loaded session; the native DB supplies the exact ID and last-run model. */
function opencodeIdentity(session: NativeSession, screen: string | null, cliVersion: string): NativeIdentity | null {
  if (!screen) return null;
  let db: DatabaseSync | null = null;
  try {
    const title = tmux(['display-message', '-p', '-t', session.tmuxPane, '#{pane_title}']).trim();
    if (!title.startsWith('OC | ') || title.length > 200) return null;
    const activeTitle = title.slice('OC | '.length);
    if (!activeTitle || /[\r\n\0]/.test(activeTitle)) return null;
    const dataHome = processEnvironment(session.pid, 'XDG_DATA_HOME');
    if (!dataHome || !path.isAbsolute(dataHome)) return null;
    const database = path.join(dataHome, 'opencode', 'opencode.db');
    const stat = fs.lstatSync(database);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) return null;
    const cwd = fs.readlinkSync(`/proc/${session.pid}/cwd`);
    db = new DatabaseSync(database, { readOnly: true });
    const matches = db.prepare('SELECT id, version, model FROM session WHERE title = ? AND directory = ?').all(activeTitle, cwd) as Array<{ id: string; version: string; model: string | null }>;
    if (matches.length !== 1 || matches[0]!.version !== cliVersion || !/^ses_[A-Za-z0-9_-]{10,128}$/.test(matches[0]!.id)) return null;
    const selected: unknown = matches[0]!.model ? JSON.parse(matches[0]!.model) : null;
    if (typeof selected !== 'object' || selected === null || Array.isArray(selected)) return null;
    const chosen = selected as Record<string, unknown>;
    if (typeof chosen.providerID !== 'string' || typeof chosen.id !== 'string') return null;
    const messages = db.prepare('SELECT data FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT 8')
      .all(matches[0]!.id) as Array<{ data: string }>;
    const assistant = messages.map(row => JSON.parse(row.data) as unknown)
      .find(value => typeof value === 'object' && value !== null && !Array.isArray(value)
        && (value as Record<string, unknown>).role === 'assistant') as Record<string, unknown> | undefined;
    if (!assistant || typeof assistant.providerID !== 'string' || typeof assistant.modelID !== 'string') return null;
    const provider = assistant.providerID;
    const model = `${provider}/${assistant.modelID}`;
    if (!PROVIDERS.opencode?.includes(provider) || chosen.providerID !== provider || chosen.id !== assistant.modelID) return null;
    const display: Record<string, string> = { deepseek: 'DeepSeek', anthropic: 'Anthropic', openai: 'OpenAI' };
    const footer = new RegExp(`^\\s*┃?\\s*[A-Za-z][A-Za-z0-9 _-]*\\s*·\\s*.+\\s${display[provider]}\\s*$`, 'u');
    if (!screen.split('\n').some(line => footer.test(line))) return null;
    return { sessionId: matches[0]!.id, provider, model, method: 'opencode-pane-sqlite-image-v1' };
  } catch { return null; }
  finally { db?.close(); }
}

function nativeIdentity(session: NativeSession, screen: string | null, cliVersion: string): NativeIdentity | null {
  if (session.harness === 'codex') return codexSessionId(screen) && codexStatusMatchesProfile(screen, session)
    ? { sessionId: codexSessionId(screen)!, provider: session.provider, model: session.model, method: 'codex-status-image-v2' }
    : null;
  if (session.harness === 'claude') return claudeIdentity(screen, session.model);
  return opencodeIdentity(session, screen, cliVersion);
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
  status = nativeStatus, version = nativeVersion,
): NativeSession {
  const captured = value && typeof value === 'object' ? { ...value, capturedAt: new Date(now()).toISOString() } : value;
  const session = decodeNativeSession(captured);
  if (!session || !sameProcess(session, observe(session.pid))) throw new Error('native fixture observation is incomplete or disagrees with the live process');
  if (!nativeCommand(session)) throw new Error('native harness and explicit model flag are absent from exact launch argv');
  if (!paneIsTty((captured as { tmuxPane: string }).tmuxPane, session.tty)) throw new Error('native process does not use the recorded tmux pane TTY');
  const imageOutput = version(session);
  const imageVersion = parsedVersion(session.harness, imageOutput);
  if (!imageVersion || imageVersion !== session.cliVersion || !sameProcess(session, observe(session.pid))
    || !paneIsTty(session.tmuxPane, session.tty)) {
    throw new Error('native CLI version is unproven by the running executable');
  }
  const screen = status(session);
  const identity = nativeIdentity(session, screen, imageVersion);
  if (!identity || identity.sessionId !== session.sessionId || identity.provider !== session.provider
    || identity.model !== session.model || !sameProcess(session, observe(session.pid))
    || !paneIsTty(session.tmuxPane, session.tty)) {
    throw new Error('native session ID is unproven by the live fixture status, provider, or model');
  }
  const directory = recordDir(root, session.repository, session.runId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const file = recordPath(root, session.repository, session.runId, session.ticket, session.role);
  const finalRecord = {
    ...(captured as Record<string, unknown>),
    capturedAt: new Date(now()).toISOString(),
    versionOutput: imageOutput!.trim(),
    nativeIdentityProof: { method: identity.method, sessionId: identity.sessionId, cliVersion: imageVersion },
  };
  const finalSession = decodeNativeSession(finalRecord);
  if (!finalSession) throw new Error('native fixture observation changed during capture');
  fs.writeFileSync(file, JSON.stringify(finalRecord), { flag: 'wx', mode: 0o600 });
  return finalSession;
}

/** A held native fixture can change its active session without changing PID or TTY. */
function holdsNativeIdentity(
  session: NativeSession, observe: typeof observeProcess, paneIsTty: typeof verifiedPane,
  status: typeof nativeStatus, version: typeof nativeVersion,
): boolean {
  if (!sameProcess(session, observe(session.pid)) || !paneIsTty(session.tmuxPane, session.tty)) return false;
  const imageVersion = parsedVersion(session.harness, version(session));
  if (imageVersion !== session.cliVersion) return false;
  const identity = nativeIdentity(session, status(session), imageVersion);
  return identity?.sessionId === session.sessionId && identity.provider === session.provider
    && identity.model === session.model && sameProcess(session, observe(session.pid))
    && paneIsTty(session.tmuxPane, session.tty);
}

/** Exact run/ticket/role lookup; a second participant makes the record ambiguous. */
export function aiurRecords(
  root: string, repository: string, observe = observeProcess, paneIsTty = verifiedPane,
  status = nativeStatus, version = nativeVersion,
): AiurPort {
  return {
    async session(ticket, runId, role) {
      if (!RUN.test(runId) || (role !== 'a' && role !== 'b')) return null;
      const file = recordPath(root, repository, runId, ticket, role);
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.uid !== process.getuid?.()) return null;
        const record: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
        const session = decodeNativeSession(record);
        if (!session || session.repository !== repository || session.runId !== runId || session.ticket !== ticket || session.role !== role) return null;
        const proof = (record as Record<string, unknown>).nativeIdentityProof;
        const expectedMethod: Record<NativeSession['harness'], string> = {
          codex: 'codex-status-image-v2', claude: 'claude-status-image-v1', opencode: 'opencode-pane-sqlite-image-v1',
        };
        if (!proof || typeof proof !== 'object' || Array.isArray(proof)
          || (proof as Record<string, unknown>).method !== expectedMethod[session.harness]
          || (proof as Record<string, unknown>).sessionId !== session.sessionId
          || (proof as Record<string, unknown>).cliVersion !== session.cliVersion) return null;
        if (!holdsNativeIdentity(session, observe, paneIsTty, status, version)) return null;
        const other = role === 'a' ? 'b' : 'a';
        const sibling = recordPath(root, repository, runId, ticket, other);
        if (fs.existsSync(sibling)) return null;
        return session;
      } catch { return null; }
    },
    async alive(session) { return holdsNativeIdentity(session, observe, paneIsTty, status, version); },
  };
}
