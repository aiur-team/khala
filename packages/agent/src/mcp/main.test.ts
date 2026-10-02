import { spawnSync } from 'node:child_process';
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
  it('exports the C12 entry and serves the placeholder through the untouched bin', () => {
    expect(typeof main).toBe('function');
    const result = spawnSync(process.execPath, ['bin/khala.mjs', 'mcp', '--harness', 'codex'], {
      encoding: 'utf8', input: JSON.stringify(call('khala_status', 'a')) + '\n',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout).result.structuredContent).toEqual({ state: 'idle', unread: 0 });
  });
});
