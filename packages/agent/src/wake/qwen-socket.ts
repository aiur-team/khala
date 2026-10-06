import * as fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { ensureStateDir, readJson, stateRoot, writeJsonAtomic, SESSION_ID_PATTERN } from '../state';
import type { WakeDriver } from './driver';
import { verifyQwenTranscript } from './qwen-transcript';
import { cancelAttempt, failAttempt } from './shared/nonce';

export const qwenHome = (env: NodeJS.ProcessEnv) => env.QWEN_HOME ? path.resolve(env.QWEN_HOME) : path.join(env.HOME ?? os.homedir(), '.qwen');
export const qwenControllerFile = (env: NodeJS.ProcessEnv) => path.join(stateRoot(env), 'qwen', 'controller.json');
export type QwenTarget = { socket: string; sessionId: string; token: string };
export type QwenReceipt = 'delivered' | 'held' | 'refused' | 'denied' | 'expired' | 'misaddressed' | 'dropped' | 'failed';

/** Match the inherited socket, never a guessed pid. /clear and /resume replace sessionId. */
export async function qwenSession(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const socket = env.QWEN_CODE_MESSAGING_SOCKET;
  if (!socket) return undefined;
  try {
    const dir = path.join(qwenHome(env), 'sessions');
    for (const file of await fs.readdir(dir)) {
      if (!/^\d+\.json$/u.test(file)) continue;
      const record = await readJson<{ ipcPath?: string; sessionId?: string }>(path.join(dir, file));
      if (record?.ipcPath === socket && typeof record.sessionId === 'string' && SESSION_ID_PATTERN.test(record.sessionId)) return record.sessionId;
    }
  } catch { /* A missing registry is unavailable, never a token-bearing diagnostic. */ }
  return undefined;
}

async function target(env: NodeJS.ProcessEnv): Promise<QwenTarget | undefined> {
  const sessionId = await qwenSession(env);
  if (!sessionId) return undefined;
  try {
    const file = qwenControllerFile(env);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) return undefined;
    const credential = await readJson<{ token?: string }>(file);
    if (!credential?.token || !/^qpc_[0-9a-f]{64}$/u.test(credential.token)) return undefined;
    return { socket: env.QWEN_CODE_MESSAGING_SOCKET!, sessionId, token: credential.token };
  } catch { return undefined; }
}

export function qwenFrames(target: QwenTarget, line: string, from: string, replyToken: string, msgId: string): string {
  return JSON.stringify({ msgV: 1, type: 'auth', token: target.token }) + '\n'
    + JSON.stringify({ msgV: 1, msgId, type: 'user', from, replyToken, fromName: 'khala', fromMode: 'prompting',
      toSessionId: target.sessionId, priority: 'next', message: { role: 'user', content: line } }) + '\n';
}

/** Receipts arrive on a separate authenticated connection, not the sending socket. */
export async function sendQwenWake(target: QwenTarget, line: string, signal: AbortSignal,
  options: { runtimeDir?: string; timeoutMs?: number } = {}): Promise<QwenReceipt> {
  if (signal.aborted) return 'failed';
  const dir = await fs.mkdtemp(path.join(options.runtimeDir ?? os.tmpdir(), 'khala-qw-'));
  const from = path.join(dir, 'r.sock');
  if (Buffer.byteLength(from) > 103) { await fs.rm(dir, { recursive: true, force: true }); return 'failed'; }
  const replyToken = randomBytes(32).toString('hex');
  const msgId = randomUUID();
  const peers = new Set<net.Socket>();
  let sender: net.Socket | undefined;
  let finish!: (receipt: QwenReceipt) => void;
  const result = new Promise<QwenReceipt>(resolve => { finish = resolve; });
  const aborted = () => finish('failed');
  const server = net.createServer(socket => {
    peers.add(socket);
    socket.on('close', () => peers.delete(socket));
    socket.on('error', () => {});
    let buffer = '', authenticated = false;
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 64 * 1024) { socket.destroy(); return; }
      let at: number;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const text = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        let frame;
        try { frame = JSON.parse(text); } catch { socket.destroy(); return; }
        if (!authenticated) {
          authenticated = frame?.msgV === 1 && frame.type === 'auth' && frame.token === replyToken;
          if (!authenticated) { socket.destroy(); return; }
        } else if (frame?.msgV === 1 && frame.type === 'control' && frame.action === 'delivery_status'
          && frame.origMsgId === msgId && ['delivered', 'held', 'refused', 'denied', 'expired', 'misaddressed', 'dropped'].includes(frame.status)) {
          finish(frame.status);
        }
      }
    });
  });
  server.on('error', () => finish('failed'));
  signal.addEventListener('abort', aborted, { once: true });
  const timer = setTimeout(() => finish('failed'), options.timeoutMs ?? 5000);
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(from, resolve); });
    await fs.chmod(from, 0o600);
    if (signal.aborted) return 'failed';
    sender = net.createConnection(target.socket);
    sender.on('error', () => finish('failed'));
    sender.on('connect', () => { sender!.end(qwenFrames(target, line, from, replyToken, msgId)); });
    return await result;
  } catch { return 'failed'; }
  finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', aborted);
    sender?.destroy();
    for (const socket of peers) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export function createQwenSocketDriver(deps: {
  platform?: NodeJS.Platform;
  resolve?: (env: NodeJS.ProcessEnv) => Promise<QwenTarget | undefined>;
  send?: typeof sendQwenWake;
} = {}): WakeDriver {
  const resolve = deps.resolve ?? target;
  const policy = async (env: NodeJS.ProcessEnv) => {
    const config = await readJson<{ agents?: { crossSessionInbound?: string; crossSessionMessaging?: boolean } }>(path.join(qwenHome(env), 'settings.json'));
    return config?.agents;
  };
  const reason = async (ctx: Parameters<WakeDriver['available']>[0]) => {
    if ((deps.platform ?? process.platform) === 'win32') return 'windows';
    const config = await policy(ctx.env);
    const receipt = await readJson<{ status?: string }>(path.join(ctx.files.dir, 'qwen-receipt.json'));
    if (config?.crossSessionInbound === 'hold') return 'qwen_held';
    if (receipt?.status === 'held' && config?.crossSessionInbound !== 'accept') return 'qwen_held';
    if (config?.crossSessionMessaging === false || config?.crossSessionInbound === 'refuse') return 'qwen_refused';
    return await resolve(ctx.env) ? undefined : 'qwen_socket_missing';
  };
  return {
    id: 'socket', rung: 1, optIn: false, minIdleMs: 0, deadlineMs: 30_000, verification: 'transcript',
    async verify(ctx) {
      const journal = await readJson<{ attempts?: { driver: string }[] }>(path.join(ctx.files.dir, 'wake-journal.json'));
      const receipt = await readJson<{ status?: string; nonce?: string }>(path.join(ctx.files.dir, 'qwen-receipt.json'));
      if (!journal?.attempts?.some(attempt => attempt.driver === 'socket') && receipt?.status !== 'held') return;
      const transcript = await readJson<{ path?: string }>(path.join(ctx.files.dir, 'qwen-transcript.json'));
      if (!transcript?.path) return;
      try {
        const text = await verifyQwenTranscript(ctx.files.dir, transcript.path, ctx.now);
        if (receipt?.status === 'held' && receipt.nonce && text?.includes(`(k-${receipt.nonce})`)) {
          await writeJsonAtomic(path.join(ctx.files.dir, 'qwen-receipt.json'), { status: 'delivered' });
        }
      } catch { /* Missing/rotating transcripts never authorize an unverified wake. */ }
    },
    available: async ctx => !await reason(ctx), unavailableReason: reason,
    async wake(ctx, line) {
      if (ctx.signal.aborted || await reason(ctx)) return 'skipped';
      const destination = await resolve(ctx.env);
      if (!destination || destination.sessionId !== ctx.sessionId) return 'skipped';
      const status = await (deps.send ?? sendQwenWake)(destination, line, ctx.signal);
      await ensureStateDir(ctx.files.dir);
      const nonce = line.match(/\(k-([0-9a-f]{8})\)$/u)?.[1];
      await writeJsonAtomic(path.join(ctx.files.dir, 'qwen-receipt.json'), { status, nonce });
      if (nonce && status === 'held') await cancelAttempt(ctx.files.dir, nonce);
      else if (nonce && status !== 'delivered') await failAttempt(ctx.files.dir, nonce, ctx.now);
    },
  };
}
