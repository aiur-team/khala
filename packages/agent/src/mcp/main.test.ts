import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import main, { createPlaceholderClient, runMcpCommand } from './main';

const call = (name: string, threadId?: string, args = {}) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
  name, arguments: args, ...(threadId === undefined ? {} : { _meta: { threadId } }),
} });
function streams(messages: unknown[]) {
  let text = '';
  return {
    input: Readable.from(messages.map(message => JSON.stringify(message) + '\n')),
    output: new Writable({ write(chunk, _encoding, done) { text += chunk.toString(); done(); } }),
    responses: () => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
  };
}

describe('MCP command lifecycle', () => {
  it('creates clients lazily once per session and closes all at EOF despite close rejection', async () => {
    const clients = [createPlaceholderClient(), createPlaceholderClient()];
    clients[0]!.close = vi.fn(async () => { throw new Error('close failed'); });
    clients[1]!.close = vi.fn(async () => {});
    const createClient = vi.fn(() => clients[createClient.mock.calls.length - 1]!);
    const io = streams([call('khala_status', 'a'), call('khala_status', 'b'), call('khala_status', 'a')]);
    expect(await runMcpCommand(['--harness', 'codex'], { ...io, env: {}, createClient })).toBe(0);
    expect(createClient.mock.calls).toEqual([[{ harness: 'codex', sessionId: 'a', rejoinable: true }], [{ harness: 'codex', sessionId: 'b', rejoinable: true }]]);
    for (const client of clients) expect(client.close).toHaveBeenCalledTimes(1);
  });
  it('returns the placeholder results through the real server', async () => {
    const io = streams([call('khala_send', 'a', { text: 'hello' }), call('khala_status', 'a'), call('khala_join', 'a', { link: 'https://example.com' }), call('khala_read', 'a')]);
    expect(await runMcpCommand(['--harness', 'codex'], { ...io, env: {}, createClient: createPlaceholderClient })).toBe(0);
    expect(io.responses().map(response => response.result.structuredContent)).toEqual([
      { error: 'not_connected' }, { state: 'idle', unread: 0, listeningMode: 'sync' }, { error: 'link_unavailable' }, { error: 'not_connected' },
    ]);
  });
  it('never creates clients for absent or unsafe sessions', async () => {
    const io = streams([call('khala_status'), call('khala_status', '../x')]);
    const createClient = vi.fn(createPlaceholderClient);
    await runMcpCommand(['--harness', 'codex'], { ...io, env: {}, createClient });
    expect(createClient).not.toHaveBeenCalled();
    expect(io.responses().map(response => response.result.structuredContent)).toEqual([{ error: 'session_unknown', hint: 'Send the agent one message first, then retry.' }, { error: 'session_unknown', hint: 'Send the agent one message first, then retry.' }]);
  });
  it('rejects invalid harness before reading input', async () => {
    const input = new Readable({ read() { throw new Error('must not read'); } });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await runMcpCommand(['--harness', 'bad'], { input, createClient: createPlaceholderClient })).toBe(2);
      expect(stderr).toHaveBeenCalledWith('khala: invalid --harness\n');
    } finally { stderr.mockRestore(); input.destroy(); }
  });
  it('closes clients on transport failure', async () => {
    const io = streams([call('khala_status', 'a')]);
    const client = createPlaceholderClient();
    client.close = vi.fn(async () => {});
    const output = new Writable({ write(_chunk, _encoding, done) { done(new Error('write failed')); } });
    output.on('error', () => {});
    await expect(runMcpCommand([], { ...io, output, env: {}, createClient: () => client })).rejects.toThrow('write failed');
    expect(client.close).toHaveBeenCalledTimes(1);
  });
  it('exits on SIGTERM with stdin open after initializing a real session', async () => {
    const stateHome = mkdtempSync(path.join(os.tmpdir(), 'khala-mcp-signal-'));
    const child = spawn(process.execPath, ['bin/khala.mjs', 'mcp', '--harness', 'claude'], {
      env: { ...process.env, XDG_STATE_HOME: stateHome, CLAUDE_CODE_SESSION_ID: 'signal-session' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    try {
      const reply = new Promise<string>((resolve, reject) => {
        let output = '';
        child.stdout.on('data', chunk => {
          output += chunk.toString();
          if (output.includes('\n')) resolve(output.trim());
        });
        child.once('error', reject);
      });
      const completed = (async () => {
        child.stdin.write(JSON.stringify(call('khala_status')) + '\n');
        expect(JSON.parse(await reply).result.structuredContent).toEqual({ state: 'idle', unread: 0, listeningMode: 'sync', channels: [], idleWake: { driver: 'watcher', state: 'unavailable', reason: 'The Claude watcher is not armed.' } });
        expect(existsSync(path.join(stateHome, 'khala/claude/signal-session/status.json'))).toBe(true);
        child.kill('SIGTERM');
        expect(await closed).toEqual({ code: 0, signal: null });
      })();
      await Promise.race([completed, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('mcp_signal_timeout')), 4000);
      })]);
    } finally {
      if (timer) clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
      rmSync(stateHome, { recursive: true, force: true });
    }
  });
  it('keeps SDK console diagnostics off protocol stdout', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'khala-mcp-console-'));
    const preload = path.join(dir, 'diagnostic.cjs');
    writeFileSync(preload, "process.stdin.once('end', () => console.log('sdk-diagnostic'));\n");
    try {
      const result = spawnSync(process.execPath, ['bin/khala.mjs', 'mcp', '--harness', 'claude'], {
        env: { ...process.env, XDG_STATE_HOME: dir, NODE_OPTIONS: `--require=${preload}` }, encoding: 'utf8',
        input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\n',
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).result.tools.map((tool: { name: string }) => tool.name))
        .toEqual(['khala_join', 'khala_status', 'khala_read', 'khala_send', 'khala_leave', 'khala_event']);
      expect(result.stderr).toBe('sdk-diagnostic\n');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('exits after successful cleanup despite lingering SDK timers', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'khala-mcp-deadline-'));
    const preload = path.join(dir, 'deadline.cjs');
    writeFileSync(preload, "process.stdin.once('end', () => setInterval(() => {}, 60000));\n");
    try {
      const result = spawnSync(process.execPath, ['bin/khala.mjs', 'mcp', '--harness', 'claude'], {
        env: { ...process.env, NODE_OPTIONS: `--require=${preload}`, XDG_STATE_HOME: dir, CLAUDE_CODE_SESSION_ID: 'deadline' },
        encoding: 'utf8', input: JSON.stringify(call('khala_status')) + '\n', timeout: 4000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).result.structuredContent).toEqual({ state: 'idle', unread: 0, listeningMode: 'sync', channels: [], idleWake: { driver: 'watcher', state: 'unavailable', reason: 'The Claude watcher is not armed.' } });
      expect(JSON.parse(readFileSync(path.join(dir, 'khala/claude/deadline/status.json'), 'utf8')).detail).toBe('closed');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(['reject', 'timeout'])('exits nonzero when session cleanup fails: %s', mode => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'khala-mcp-cleanup-'));
    const preload = path.join(dir, 'cleanup.cjs');
    writeFileSync(preload, `
      const fs = require('node:fs/promises');
      const unlink = fs.unlink;
      let sessionRemovals = 0;
      fs.unlink = file => {
        if (String(file).endsWith('/session.json') && ++sessionRemovals === 2) {
          return ${mode === 'reject' ? "Promise.reject(new Error('sensitive-private-error'))" : "new Promise(() => {})"};
        }
        return unlink(file);
      };
    `);
    try {
      const result = spawnSync(process.execPath, ['bin/khala.mjs', 'mcp', '--harness', 'claude'], {
        env: { ...process.env, NODE_OPTIONS: `--require=${preload}`, XDG_STATE_HOME: dir, CLAUDE_CODE_SESSION_ID: 'failure' },
        encoding: 'utf8', input: JSON.stringify(call('khala_status')) + '\n', timeout: 8000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toBe(`khala: cleanup_${mode === 'reject' ? 'failed' : 'timeout'}\n`);
      expect(result.stderr).not.toContain('sensitive-private-error');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 10_000);
  it('exports the C12 entry and serves the real client through the untouched bin', () => {
    expect(typeof main).toBe('function');
    const stateHome = mkdtempSync(path.join(os.tmpdir(), 'khala-mcp-main-'));
    try {
      const result = spawnSync(process.execPath, ['bin/khala.mjs', 'mcp', '--harness', 'codex'], {
        env: { ...process.env, PATH: '', XDG_STATE_HOME: stateHome },
        encoding: 'utf8', input: JSON.stringify(call('khala_status', 'a')) + '\n',
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout).result.structuredContent).toEqual({ state: 'idle', unread: 0, listeningMode: 'sync', channels: [], idleWake: { driver: 'queue', state: 'unavailable', reason: 'Codex queue is missing.' } });
    } finally { rmSync(stateHome, { recursive: true, force: true }); }
  });
});

it('forwards khala_leave through the real CLI wrapper', () => {
  const stateHome = mkdtempSync(path.join(os.tmpdir(), 'khala-leave-cli-'));
  try {
    const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../../bin/khala.mjs'), 'mcp', '--harness', 'claude'], {
      cwd: path.resolve(import.meta.dirname, '../../../..'),
      env: { ...process.env, XDG_STATE_HOME: stateHome, CLAUDE_CODE_SESSION_ID: 'leave-cli' },
      input: JSON.stringify(call('khala_leave', undefined, { channel: 'A' })) + '\n', encoding: 'utf8', timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).result.structuredContent).toEqual({ error: 'channel_unknown', channels: [] });
  } finally { rmSync(stateHome, { recursive: true, force: true }); }
});

it.each(['codex', 'claude'] as const)('creates the %s startup client without input and reuses it', async harness => {
  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const controller = new AbortController();
  const client = createPlaceholderClient();
  client.close = vi.fn(async () => {});
  const createClient = vi.fn(() => client);
  const env = harness === 'codex' ? { CODEX_THREAD_ID: 'resume' } : { CLAUDE_CODE_SESSION_ID: 'resume' };
  const running = runMcpCommand(['--harness', harness], { input, output, signal: controller.signal, createClient, env });
  await vi.waitFor(() => expect(createClient).toHaveBeenCalledOnce());
  expect(createClient).toHaveBeenCalledExactlyOnceWith({ harness, sessionId: 'resume', rejoinable: true });
  input.end(JSON.stringify(call('khala_status', 'resume')) + '\n');
  await running;
  expect(createClient).toHaveBeenCalledOnce();
  expect(client.close).toHaveBeenCalledOnce();
  output.destroy();
});

it.each([undefined, '/work/project'])('skips Cursor startup restore for workspace %s but creates clients on tool calls', async workspace => {
  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const client = createPlaceholderClient();
  client.close = vi.fn(async () => {});
  const createClient = vi.fn<(input: { harness: string; sessionId: string }) => typeof client>(() => client);
  const env = workspace === undefined ? {} : { KHALA_CURSOR_WORKSPACE: workspace };
  const running = runMcpCommand(['--harness', 'cursor'], { input, output, createClient, env });
  expect(createClient).not.toHaveBeenCalled();
  input.end(JSON.stringify(call('khala_status', undefined)) + '\n');
  await running;
  expect(createClient).toHaveBeenCalledOnce();
  expect(createClient.mock.calls[0]![0]).toMatchObject({ harness: 'cursor' });
  expect(client.close).toHaveBeenCalledOnce();
  output.destroy();
});
