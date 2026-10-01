import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { chmod, link, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SessionBinding } from '@khala/contracts/delivery/index';

export type ClaudeHostedBoundary = 'post_tool_use' | 'stop';
export type ClaudeHostedHookDelivery = Readonly<{
  boundary: ClaudeHostedBoundary;
  binding: SessionBinding;
  releaseIds: readonly string[];
  frame: string;
  token: string;
}>;
export type ClaudeHostedHookBridgePort = Readonly<{
  pull(boundary: ClaudeHostedBoundary): Promise<ClaudeHostedHookDelivery | null>;
  /** Recheck the held binding, generation, mode and pause state on every call. */
  current(delivery: ClaudeHostedHookDelivery): Promise<boolean>;
  /** Commit the durable inbox acknowledgement for exactly this delivery. */
  acknowledge(delivery: ClaudeHostedHookDelivery): Promise<void>;
}>;
export type ClaudeHostedHookReceipt = Readonly<{
  kind: 'acknowledged'; boundary: ClaudeHostedBoundary; sessionFingerprint: string;
  bindingId: string; generation: number;
  releaseIds: readonly string[];
}>;

type Pending = Readonly<{ delivery: ClaudeHostedHookDelivery; nonce: string }>;
const NONCE = /^[A-Za-z0-9_-]{32}$/u;
const MAX_REQUEST_BYTES = 2048;
const MAX_RESPONSE_BYTES = 512 * 1024;

export function claudeHostedHookPaths(root: string, sessionId: string): Readonly<{ descriptor: string; socketPrefix: string }> {
  const key = createHash('sha256').update(['khala.hosted.claude.hook.v1', sessionId].join('\0')).digest('hex').slice(0, 24);
  const directory = path.join(root, 'hosted-claude-hooks');
  return { descriptor: path.join(directory, `${key}.json`), socketPrefix: path.join(root, `h-${key.slice(0, 8)}`) };
}

/**
 * The MCP process is the only writer of receipts. The hook receives an opaque
 * one-use nonce; binding, generation, release IDs and boundary remain here and
 * are checked again before a later agent-origin call commits the ACK.
 */
export async function startClaudeHostedHookBridge(input: Readonly<{
  root: string; sessionId: string; port: ClaudeHostedHookBridgePort;
}>): Promise<Readonly<{ acknowledge(nonce: string): Promise<ClaudeHostedHookReceipt | 'stale'>; close(): Promise<void> }>> {
  const { descriptor, socketPrefix } = claudeHostedHookPaths(input.root, input.sessionId);
  const sessionFingerprint = createHash('sha256').update(['khala.hosted.claude.receipt.v1', input.sessionId].join('\0'))
    .digest('base64url').slice(0, 24);
  const directory = path.dirname(descriptor);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await stat(directory);
  if (!directoryStat.isDirectory() || (directoryStat.mode & 0o777) !== 0o700
    || (typeof process.getuid === 'function' && directoryStat.uid !== process.getuid())) throw new Error('unsafe_hook_directory');
  const secret = randomBytes(32).toString('base64url');
  const socketPath = `${socketPrefix}-${randomBytes(6).toString('hex')}.sock`;
  if (Buffer.byteLength(socketPath) >= 108) throw new Error('hook_socket_path_too_long');
  let pending: Pending | null = null;
  let closed = false;
  const sockets = new Set<Socket>();
  let tail: Promise<void> = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    tail = next.then(() => undefined, () => undefined);
    return next;
  };
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.setTimeout(10_000, () => socket.destroy());
    void receive(socket).catch(() => socket.destroy());
  });
  async function receive(socket: Socket): Promise<void> {
    const raw = await new Promise<string | null>(resolve => {
      let text = '';
      const finish = (value: string | null) => {
        socket.off('data', data); socket.off('end', end); socket.off('error', end);
        resolve(value);
      };
      const end = () => finish(null);
      const data = (chunk: Buffer) => {
        text += chunk.toString('utf8');
        if (Buffer.byteLength(text) > MAX_REQUEST_BYTES) return finish(null);
        const newline = text.indexOf('\n');
        if (newline >= 0) finish(text.slice(0, newline));
      };
      socket.on('data', data); socket.once('end', end); socket.once('error', end);
    });
    if (raw === null) { socket.destroy(); return; }
    let request: unknown;
    try { request = JSON.parse(raw); }
    catch { socket.end('{"kind":"unsupported"}\n'); return; }
    const value = request as Record<string, unknown>;
    const actual = typeof value?.secret === 'string' ? Buffer.from(value.secret) : Buffer.alloc(0);
    const expected = Buffer.from(secret);
    if (closed || value?.v !== 1 || value?.sessionId !== input.sessionId
      || actual.length !== expected.length || !timingSafeEqual(actual, expected)
      || !['post_tool_use', 'stop'].includes(String(value.boundary))) {
      socket.end('{"kind":"unsupported"}\n'); return;
    }
    const boundary = value.boundary as ClaudeHostedBoundary;
    const response = await serialize(async () => {
      if (pending && !await input.port.current(pending.delivery)) pending = null;
      if (pending && pending.delivery.boundary !== boundary) return '{"kind":"empty"}';
      if (!pending) {
        const delivery = await input.port.pull(boundary);
        if (delivery === null || delivery.boundary !== boundary || delivery.releaseIds.length === 0
          || !await input.port.current(delivery)) return '{"kind":"empty"}';
        pending = { delivery, nonce: randomBytes(24).toString('base64url') };
      }
      const answer = JSON.stringify({ kind: 'batch', frame: pending.delivery.frame, receiptNonce: pending.nonce });
      return Buffer.byteLength(answer) <= MAX_RESPONSE_BYTES ? answer : '{"kind":"unsupported"}';
    });
    socket.end(`${response}\n`);
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => { server.off('error', reject); resolve(); });
  });
  try {
    await chmod(socketPath, 0o600);
    try {
      const old = JSON.parse(await readFile(descriptor, 'utf8')) as { socketPath?: string };
      if (typeof old.socketPath !== 'string' || path.dirname(old.socketPath) !== input.root) throw new Error('unsafe_hook_descriptor');
      if (await socketAlive(old.socketPath)) throw new Error('active_hook_bridge_exists');
      await rm(descriptor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const temporary = `${descriptor}.${process.pid}.${randomBytes(6).toString('hex')}`;
    try {
      await writeFile(temporary, JSON.stringify({ v: 1, sessionId: input.sessionId, socketPath, secret }), { mode: 0o600, flag: 'wx' });
      await link(temporary, descriptor);
    } finally { await rm(temporary, { force: true }); }
  } catch (error) {
    await closeServer(server);
    await rm(socketPath, { force: true });
    throw error;
  }
  return {
    async acknowledge(nonce) {
      return serialize(async () => {
        if (closed || !NONCE.test(nonce) || pending?.nonce !== nonce) return 'stale';
        const selected = pending;
        if (!await input.port.current(selected.delivery)) { pending = null; return 'stale'; }
        pending = null;
        await input.port.acknowledge(selected.delivery);
        return { kind: 'acknowledged', boundary: selected.delivery.boundary, sessionFingerprint,
        bindingId: selected.delivery.binding.bindingId, generation: selected.delivery.binding.generation,
        releaseIds: selected.delivery.releaseIds };
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      pending = null;
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
      try {
        const current = JSON.parse(await readFile(descriptor, 'utf8')) as { secret?: string };
        if (current.secret === secret) await rm(descriptor, { force: true });
      } catch { /* A newer bridge owns the descriptor. */ }
      await rm(socketPath, { force: true });
    },
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

function socketAlive(socketPath: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection(socketPath);
    const done = (alive: boolean) => { socket.destroy(); resolve(alive); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(200, () => done(false));
  });
}
