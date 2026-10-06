import * as fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createQwenSocketDriver, qwenFrames, qwenSession, sendQwenWake } from './qwen-socket';
import { filesForDir } from '../state';
import { readWakeState, recordAttempt } from './shared/nonce';
import { wakeStatus } from './status';

const roots: string[] = [];
async function temp() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qw-')); roots.push(root); return root; }
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

it('sends exact newline frames and authenticates a receipt on a separate socket', async () => {
  const root = await temp(), socket = path.join(root, 'q.sock');
  let bytes = '';
  const server = net.createServer(peer => {
    peer.setEncoding('utf8'); peer.on('data', data => { bytes += data; });
    peer.on('end', () => {
      const [auth, frame] = bytes.trimEnd().split('\n').map(line => JSON.parse(line));
      expect(auth).toEqual({ msgV: 1, type: 'auth', token: 'private-controller' });
      const receipt = net.createConnection(frame.from);
      receipt.on('connect', () => receipt.end(JSON.stringify({ msgV: 1, type: 'auth', token: frame.replyToken }) + '\n'
        + JSON.stringify({ msgV: 1, type: 'control', action: 'delivery_status', origMsgId: frame.msgId, status: 'delivered' }) + '\n'));
    });
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  try {
    const destination = { socket, sessionId: 'session', token: 'private-controller' };
    expect(await sendQwenWake(destination, 'Khala: channel messages are waiting. Continue. (k-12345678)', new AbortController().signal, { runtimeDir: root })).toBe('delivered');
    const frame = JSON.parse(bytes.trimEnd().split('\n')[1]!);
    expect(bytes).toBe(qwenFrames(destination, 'Khala: channel messages are waiting. Continue. (k-12345678)', frame.from, frame.replyToken, frame.msgId));
    expect(frame).toMatchObject({ msgV: 1, type: 'user', fromName: 'khala', fromMode: 'prompting', priority: 'next', toSessionId: 'session' });
    expect(await fs.readdir(root)).toEqual(['q.sock']);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('times out unauthenticated receipts and cleans up on abort', async () => {
  const root = await temp(), socket = path.join(root, 'q.sock');
  const server = net.createServer(peer => { peer.resume(); });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  const controller = new AbortController();
  try {
    const pending = sendQwenWake({ socket, sessionId: 's', token: 'secret' }, 'line', controller.signal, { runtimeDir: root, timeoutMs: 50 });
    setTimeout(() => controller.abort(), 10);
    expect(await pending).toBe('failed');
    expect(await fs.readdir(root)).toEqual(['q.sock']);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('re-reads the socket-matched registry after clear or resume', async () => {
  const root = await temp(), env = { QWEN_HOME: root, QWEN_CODE_MESSAGING_SOCKET: '/q.sock' };
  await fs.mkdir(path.join(root, 'sessions'));
  const file = path.join(root, 'sessions', '123.json');
  await fs.writeFile(file, JSON.stringify({ ipcPath: '/other', sessionId: 'wrong' }));
  expect(await qwenSession(env)).toBeUndefined();
  await fs.writeFile(file, JSON.stringify({ ipcPath: '/q.sock', sessionId: 'first' }));
  expect(await qwenSession(env)).toBe('first');
  await fs.writeFile(file, JSON.stringify({ ipcPath: '/q.sock', sessionId: 'resumed' }));
  expect(await qwenSession(env)).toBe('resumed');
});

it('refused receipts fail twice and disable; held receipts cancel without failure or retry', async () => {
  const root = await temp(), sessionDir = path.join(root, 'khala', 'qwen', 's'), files = filesForDir(sessionDir);
  await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const env = { HOME: root, QWEN_HOME: root };
  let status: 'refused' | 'held' = 'refused';
  let sends = 0;
  const driver = createQwenSocketDriver({ resolve: async () => ({ socket: '/fake', sessionId: 's', token: 'secret' }),
    send: async () => { sends++; return status; } });
  const ctx = { files, harness: 'qwen', sessionId: 's', env, signal: new AbortController().signal, now: 10 };
  for (const nonce of ['11111111', '22222222']) {
    await recordAttempt(sessionDir, { nonce, driver: 'socket', at: 1, deadline: 100, verification: 'transcript' });
    await driver.wake(ctx, `Khala: channel messages are waiting. Continue. (k-${nonce})`);
  }
  expect((await readWakeState(sessionDir)).socket).toMatchObject({ failures: 2, disabled: true });
  status = 'held';
  const heldDir = path.join(root, 'khala', 'qwen', 'held'); await fs.mkdir(heldDir, { mode: 0o700 });
  const held = { ...ctx, files: filesForDir(heldDir) };
  await recordAttempt(heldDir, { nonce: '33333333', driver: 'socket', at: 1, deadline: 100, verification: 'transcript' });
  await driver.wake(held, 'Khala: channel messages are waiting. Continue. (k-33333333)');
  expect(await readWakeState(heldDir)).toEqual({});
  expect(await driver.available(held)).toBe(false);
  expect(await driver.wake(held, 'line')).toBe('skipped');
  expect(sends).toBe(3);
  const rows = await wakeStatus('qwen', { env, files: held.files, sessionId: 's' });
  expect(rows[0]).toMatchObject({ state: 'held', reason: 'Held by your Qwen setting.' });
  expect(JSON.stringify(rows)).not.toContain('secret');
});

it('verifies native delivery during a long turn and resumes after a held receipt is released', async () => {
  const root = await temp(), dir = path.join(root, 'khala', 'qwen', 's');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const files = filesForDir(dir), env = { HOME: root, QWEN_HOME: root };
  const transcript = path.join(root, 'transcript.jsonl');
  await fs.writeFile(path.join(dir, 'qwen-transcript.json'), JSON.stringify({ path: transcript }));
  await recordAttempt(dir, { nonce: '12345678', driver: 'socket', at: 1, deadline: 30_001, verification: 'transcript' });
  await fs.writeFile(transcript, JSON.stringify({ type: 'user', provenance: 'system', subtype: 'notification', deliveredTurn: true,
    message: { role: 'user', parts: [{ text: '(k-12345678)' }] } }) + '\n');
  const driver = createQwenSocketDriver({ resolve: async () => ({ socket: '/fake', sessionId: 's', token: 'secret' }) });
  const ctx = { files, harness: 'qwen', sessionId: 's', env, signal: new AbortController().signal, now: 1000 };
  await fs.appendFile(transcript, JSON.stringify({ type: 'user', provenance: 'system', subtype: 'notification', deliveredTurn: true, message: { role: 'user', parts: [{ text: 'unrelated notification' }] } }) + '\n');
  await driver.verify!(ctx);
  // No Stop hook yet: the long turn crosses the verification deadline safely.
  const { settleAttempts } = await import('./shared/nonce');
  expect(await settleAttempts(dir, { now: 60_000, activity: { state: 'idle', updatedAt: 1 } })).toEqual([]);
  expect(await readWakeState(dir)).toEqual({ socket: { failures: 0 } });
  await fs.writeFile(path.join(dir, 'qwen-receipt.json'), JSON.stringify({ status: 'held', nonce: '12345678' }));
  expect(await driver.available(ctx)).toBe(false);
  await driver.verify!(ctx);
  expect(await driver.available(ctx)).toBe(true);
  await fs.writeFile(path.join(dir, 'qwen-receipt.json'), JSON.stringify({ status: 'held' }));
  await fs.writeFile(path.join(root, 'settings.json'), JSON.stringify({ agents: { crossSessionInbound: 'accept' } }));
  expect(await driver.available(ctx)).toBe(true);
  await fs.writeFile(path.join(root, 'settings.json'), JSON.stringify({ agents: { crossSessionInbound: 'hold' } }));
  expect(await driver.available(ctx)).toBe(false);
});

it.each(['wrong-token', 'wrong-id'])('ignores %s receipts and times out without abort', async fault => {
  const root = await temp(), socket = path.join(root, 'q.sock');
  const server = net.createServer(peer => {
    let bytes = ''; peer.setEncoding('utf8'); peer.on('data', data => bytes += data);
    peer.on('end', () => {
      const frame = JSON.parse(bytes.trimEnd().split('\n')[1]!);
      const receipt = net.createConnection(frame.from);
      receipt.on('error', () => {});
      receipt.on('connect', () => receipt.end(JSON.stringify({ msgV: 1, type: 'auth', token: fault === 'wrong-token' ? 'wrong' : frame.replyToken }) + '\n'
        + JSON.stringify({ msgV: 1, type: 'control', action: 'delivery_status', origMsgId: fault === 'wrong-id' ? 'unknown' : frame.msgId, status: 'delivered' }) + '\n'));
    });
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  try {
    expect(await sendQwenWake({ socket, sessionId: 's', token: 'secret' }, 'line', new AbortController().signal, { runtimeDir: root, timeoutMs: 100 })).toBe('failed');
    expect(await fs.readdir(root)).toEqual(['q.sock']);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('refuses readable or symlinked controller credentials', async () => {
  const root = await temp(), sessionDir = path.join(root, 'state', 'khala', 'qwen', 's');
  await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const env = { HOME: root, XDG_STATE_HOME: path.join(root, 'state'), QWEN_HOME: path.join(root, 'qwen'), QWEN_CODE_MESSAGING_SOCKET: '/q.sock' };
  await fs.mkdir(path.join(env.QWEN_HOME, 'sessions'), { recursive: true });
  await fs.writeFile(path.join(env.QWEN_HOME, 'sessions', '123.json'), JSON.stringify({ ipcPath: '/q.sock', sessionId: 's' }));
  const credential = path.join(root, 'state', 'khala', 'qwen', 'controller.json');
  await fs.writeFile(credential, JSON.stringify({ token: 'qpc_' + 'a'.repeat(64) }), { mode: 0o600 });
  const driver = createQwenSocketDriver();
  const ctx = { files: filesForDir(sessionDir), harness: 'qwen', sessionId: 's', env, signal: new AbortController().signal, now: 1 };
  expect(await driver.available(ctx)).toBe(true);
  await fs.chmod(credential, 0o644);
  expect(await driver.available(ctx)).toBe(false);
  await fs.rm(credential);
  const other = path.join(root, 'other.json');
  await fs.writeFile(other, JSON.stringify({ token: 'qpc_' + 'a'.repeat(64) }), { mode: 0o600 });
  await fs.symlink(other, credential);
  expect(await driver.available(ctx)).toBe(false);
});

it('explicit re-consent clears a stale held receipt without overriding hold settings', async () => {
  const root = await temp(), env = { HOME: root, XDG_STATE_HOME: path.join(root, 'state'), QWEN_HOME: root };
  const { openSessionDir } = await import('../state');
  const { setWake } = await import('./cli');
  const files = await openSessionDir('qwen', 's', env);
  const receipt = path.join(files.dir, 'qwen-receipt.json');
  await fs.writeFile(receipt, JSON.stringify({ status: 'held' }));
  const driver = createQwenSocketDriver({ resolve: async () => ({ socket: '/fake', sessionId: 's', token: 'secret' }) });
  const ctx = { files, harness: 'qwen', sessionId: 's', env, signal: new AbortController().signal, now: 1 };
  expect(await driver.available(ctx)).toBe(false);
  await setWake('qwen', ['socket'], true, env);
  await expect(fs.stat(receipt)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await driver.available(ctx)).toBe(true);
  await fs.writeFile(path.join(root, 'settings.json'), JSON.stringify({ agents: { crossSessionInbound: 'hold' } }));
  await setWake('qwen', ['socket'], true, env);
  expect(await driver.available(ctx)).toBe(false);
});
