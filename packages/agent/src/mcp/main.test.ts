import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
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
    expect(createClient.mock.calls).toEqual([[{ harness: 'codex', sessionId: 'a' }], [{ harness: 'codex', sessionId: 'b' }]]);
    for (const client of clients) expect(client.close).toHaveBeenCalledTimes(1);
  });
  it('returns the placeholder results through the real server', async () => {
    const io = streams([call('khala_send', 'a', { text: 'hello' }), call('khala_status', 'a'), call('khala_join', 'a', { link: 'https://example.com' }), call('khala_read', 'a')]);
    expect(await runMcpCommand(['--harness', 'codex'], { ...io, env: {}, createClient: createPlaceholderClient })).toBe(0);
    expect(io.responses().map(response => response.result.structuredContent)).toEqual([
      { error: 'not_connected' }, { state: 'idle', unread: 0 }, { error: 'link_unavailable' }, { error: 'not_connected' },
    ]);
  });
  it('never creates clients for absent or unsafe sessions', async () => {
    const io = streams([call('khala_status'), call('khala_status', '../x')]);
    const createClient = vi.fn(createPlaceholderClient);
    await runMcpCommand(['--harness', 'codex'], { ...io, env: {}, createClient });
    expect(createClient).not.toHaveBeenCalled();
    expect(io.responses().map(response => response.result.structuredContent)).toEqual([{ error: 'session_unknown' }, { error: 'session_unknown' }]);
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
        expect(JSON.parse(await reply).result.structuredContent).toEqual({ state: 'idle', unread: 0 });
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
  it('exports the C12 entry and serves the real client through the untouched bin', () => {
    expect(typeof main).toBe('function');
    const stateHome = mkdtempSync(path.join(os.tmpdir(), 'khala-mcp-main-'));
    try {
      const result = spawnSync(process.execPath, ['bin/khala.mjs', 'mcp', '--harness', 'codex'], {
        env: { ...process.env, XDG_STATE_HOME: stateHome },
        encoding: 'utf8', input: JSON.stringify(call('khala_status', 'a')) + '\n',
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout).result.structuredContent).toEqual({ state: 'idle', unread: 0 });
    } finally { rmSync(stateHome, { recursive: true, force: true }); }
  });
});
