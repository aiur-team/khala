import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createConnection, type Socket } from 'node:net';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

export type NativeTarget = {
  sessionId: string;
  workdir: string;
  sessionPid: number;
};

type SessionRegistry = {
  sessionId: string;
  cwd: string;
  messagingSocketPath: string;
  pid: number;
};

export type RuntimeEvidence = {
  cwd: string;
  socketPath: string;
  token: string;
  registry: SessionRegistry;
  ancestorPids: readonly number[];
};

export type SocketChildInput = {
  target: NativeTarget;
  payload: string;
  deadlineMs: number;
};

export type SocketChildResult = {
  route: 'agent_child_socket';
  sessionId: string;
  transportWritten: boolean;
  outcome: 'transport_written' | 'outcome_unknown';
  responseBytes: number;
  responseSha256: string | null;
  responseTimedOut: boolean;
  frameSha256: string;
};

type SocketChildDeps = {
  allowedTargets?: readonly NativeTarget[];
  runtime?: (target: NativeTarget) => Promise<RuntimeEvidence>;
  socketFactory?: (options: { path: string }) => Socket;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{64}$/i;
const MAX_PAYLOAD_BYTES = 65_536;
const MAX_RESPONSE_BYTES = 65_536;

// Empty until the operator designates a disposable Claude session for KHA-145.
// A live command refuses before reading a registry entry or opening a socket unless
// its exact session/workdir/pid tuple is present here.
export const DESIGNATED_TARGETS: readonly NativeTarget[] = [];

const digest = (value: string | Buffer): string => `sha256:${createHash('sha256').update(value).digest('hex')}`;

export function assertDesignatedTarget(target: NativeTarget, allowed: readonly NativeTarget[] = DESIGNATED_TARGETS): void {
  if (!UUID.test(target.sessionId) || !isAbsolute(target.workdir) || !Number.isSafeInteger(target.sessionPid) || target.sessionPid < 2) {
    throw new Error('Invalid target tuple; expected a session UUID, absolute workdir, and positive session pid');
  }
  if (!allowed.some(item => item.sessionId === target.sessionId && item.workdir === target.workdir && item.sessionPid === target.sessionPid)) {
    throw new Error('Refusing a session/workdir/pid tuple that is not a designated disposable target');
  }
}

export function buildSocketFrame(token: string, payload: string): string {
  if (!TOKEN.test(token)) throw new Error('Invalid inherited messaging token');
  const payloadBytes = Buffer.byteLength(payload);
  if (payloadBytes < 1 || payloadBytes > MAX_PAYLOAD_BYTES) throw new Error(`Invalid payload size; expected 1-${MAX_PAYLOAD_BYTES} bytes`);
  return `${JSON.stringify({ type: 'auth', token })}\n${JSON.stringify({ type: 'user', message: { role: 'user', content: payload } })}\n`;
}

async function ancestorPids(startPid = process.pid): Promise<number[]> {
  const result: number[] = [];
  let pid = startPid;
  for (let depth = 0; depth < 64 && pid > 1; depth++) {
    result.push(pid);
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
    const match = stat.match(/^\d+ \(.+\) \S (\d+) /);
    if (!match) break;
    const parent = Number(match[1]);
    if (!Number.isSafeInteger(parent) || parent < 1 || parent === pid) break;
    pid = parent;
  }
  return result;
}

async function collectRuntime(target: NativeTarget): Promise<RuntimeEvidence> {
  const socketPath = process.env.CLAUDE_CODE_MESSAGING_SOCKET ?? '';
  const token = process.env.CLAUDE_CODE_MESSAGING_TOKEN ?? '';
  if (!isAbsolute(socketPath) || !TOKEN.test(token)) throw new Error('The child does not have a valid inherited Claude messaging socket and token');
  const path = join(homedir(), '.claude', 'sessions', `${target.sessionPid}.json`);
  const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<SessionRegistry>;
  return {
    cwd: process.cwd(),
    socketPath,
    token,
    registry: {
      sessionId: String(parsed.sessionId ?? ''),
      cwd: String(parsed.cwd ?? ''),
      messagingSocketPath: String(parsed.messagingSocketPath ?? ''),
      pid: Number(parsed.pid ?? target.sessionPid),
    },
    ancestorPids: await ancestorPids(),
  };
}

function verifyRuntime(target: NativeTarget, runtime: RuntimeEvidence): void {
  if (runtime.cwd !== target.workdir) throw new Error('Runtime workdir does not match the designated target');
  if (runtime.registry.sessionId !== target.sessionId || runtime.registry.cwd !== target.workdir || runtime.registry.pid !== target.sessionPid) {
    throw new Error('Runtime registry identity does not match the designated target');
  }
  if (runtime.registry.messagingSocketPath !== runtime.socketPath || !isAbsolute(runtime.socketPath)) {
    throw new Error('Inherited socket does not match the designated target registry');
  }
  if (!runtime.ancestorPids.includes(target.sessionPid)) throw new Error('The sender is not a child of the designated Claude session');
}

async function writeSocket(
  socketPath: string,
  frame: string,
  deadlineMs: number,
  socketFactory: (options: { path: string }) => Socket = createConnection,
): Promise<{
  transportWritten: boolean;
  response: Buffer;
  responseTimedOut: boolean;
  failedAfterWrite: boolean;
}> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let responseBytes = 0;
    let writeStarted = false;
    let transportWritten = false;
    let settled = false;
    const socket = socketFactory({ path: socketPath });
    const finish = (responseTimedOut: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (!writeStarted) {
        reject(new Error('Socket failed before the frame was written'));
        return;
      }
      resolve({
        transportWritten,
        response: Buffer.concat(chunks),
        responseTimedOut,
        failedAfterWrite: !transportWritten,
      });
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (writeStarted) {
        resolve({ transportWritten, response: Buffer.concat(chunks), responseTimedOut: false, failedAfterWrite: true });
      } else {
        reject(new Error('Socket failed before the frame was written'));
      }
    };
    const timer = setTimeout(() => finish(true), deadlineMs);
    socket.once('error', fail);
    socket.on('data', chunk => {
      responseBytes += chunk.length;
      if (responseBytes > MAX_RESPONSE_BYTES) {
        fail();
        return;
      }
      chunks.push(chunk);
    });
    socket.once('close', () => finish(false));
    socket.once('connect', () => {
      writeStarted = true;
      socket.end(frame, 'utf8', () => { transportWritten = true; });
    });
  });
}

export async function runSocketChild(input: SocketChildInput, deps: SocketChildDeps = {}): Promise<SocketChildResult> {
  assertDesignatedTarget(input.target, deps.allowedTargets);
  if (!Number.isSafeInteger(input.deadlineMs) || input.deadlineMs < 100 || input.deadlineMs > 60_000) {
    throw new Error('deadlineMs must be an integer between 100 and 60000');
  }
  const runtime = await (deps.runtime ?? collectRuntime)(input.target);
  verifyRuntime(input.target, runtime);
  const frame = buildSocketFrame(runtime.token, input.payload);
  const result = await writeSocket(runtime.socketPath, frame, input.deadlineMs, deps.socketFactory);
  return {
    route: 'agent_child_socket',
    sessionId: input.target.sessionId,
    transportWritten: result.transportWritten,
    outcome: result.failedAfterWrite || result.responseTimedOut ? 'outcome_unknown' : 'transport_written',
    responseBytes: result.response.length,
    responseSha256: result.response.length > 0 ? digest(result.response) : null,
    responseTimedOut: result.responseTimedOut,
    frameSha256: digest(frame),
  };
}

const exec = promisify(execFile);

async function inventory(deadlineMs: number): Promise<Record<string, unknown>> {
  const options = { timeout: deadlineMs, killSignal: 'SIGKILL' as const, maxBuffer: 1024 * 1024, encoding: 'utf8' as const };
  const [version, help] = await Promise.all([exec('claude', ['--version'], options), exec('claude', ['--help'], options)]);
  const lines = help.stdout.split('\n').filter(line => /input-format|output-format|replay-user-messages|include-hook-events|channels|messaging/i.test(line));
  return {
    recordedAt: new Date().toISOString(),
    platform: `${process.platform} ${process.arch}`,
    node: process.version,
    version: version.stdout.trim(),
    versionSha256: digest(version.stdout),
    helpSha256: digest(help.stdout),
    relevantHelpLines: lines,
  };
}

async function readStdin(limit = MAX_PAYLOAD_BYTES + 4096): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) throw new Error('stdin exceeded the bounded input limit');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const USAGE = `Usage:
  npm run probe -- --inventory [--deadline-ms N]
  npm run probe -- --socket-child < target-and-payload.json

Live socket input is accepted only on stdin. The exact session/workdir/pid tuple must be
present in DESIGNATED_TARGETS, and the process must be that session's descendant.`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return; }
  const deadlineAt = args.indexOf('--deadline-ms');
  const deadlineMs = deadlineAt >= 0 ? Number(args[deadlineAt + 1]) : 10_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 100 || deadlineMs > 60_000) throw new Error('Invalid --deadline-ms');
  if (args[0] === '--inventory' && (args.length === 1 || (args.length === 3 && deadlineAt === 1))) {
    console.log(JSON.stringify(await inventory(deadlineMs), null, 2));
    return;
  }
  if (args.length === 1 && args[0] === '--socket-child') {
    const input = JSON.parse(await readStdin()) as SocketChildInput;
    console.log(JSON.stringify(await runSocketChild(input), null, 2));
    return;
  }
  throw new Error('Invalid arguments');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(String((error as Error).message ?? error));
    console.error(USAGE);
    process.exitCode = 1;
  });
}
