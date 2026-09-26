import fs from 'node:fs';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../cli/app.js';
import { createUnavailableClient } from './unavailable.js';
import type { ClaudeSessionClient } from './claude-session-http.js';

async function run(argv: string[], claude?: ClaudeSessionClient, stdin = '') {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', chunk => { out += chunk; });
  stderr.on('data', chunk => { err += chunk; });
  const code = await runCli(argv, {
    client: createUnavailableClient(),
    inbox: vi.fn(async () => { throw new Error('unused'); }),
    stdin: Readable.from([stdin]), stdout, stderr,
    ...(claude === undefined ? {} : { claude }),
  });
  return { code, out, err };
}

function client(overrides: Partial<ClaudeSessionClient> = {}): ClaudeSessionClient {
  return {
    pull: vi.fn(async () => ({ kind: 'empty' as const })),
    read: vi.fn(async () => ({ kind: 'empty' as const })),
    status: vi.fn(async () => ({ kind: 'status' as const, acknowledged: 2 })),
    setMode: vi.fn(async () => ({ kind: 'refused' as const, code: 'unproven' as const })),
    send: vi.fn(async () => ({ kind: 'accepted' as const, clientTxnId: 'txn-12345678', eventId: null })),
    mode: vi.fn(async () => ({ kind: 'refused' as const, code: 'unproven' as const })),
    pending: vi.fn(async () => ({ kind: 'pending' as const })),
    roster: vi.fn(async () => ({ kind: 'refused' as const, code: 'unavailable' as const })),
    listChannels: vi.fn(async () => ({ kind: 'refused' as const, code: 'unavailable' as const })),
    requestAccess: vi.fn(async () => ({ kind: 'refused' as const, code: 'unavailable' as const })),
    accessStatus: vi.fn(async () => ({ kind: 'refused' as const, code: 'unavailable' as const })),
    requestCreate: vi.fn(async () => ({ kind: 'refused' as const, code: 'unavailable' as const })),
    hook: vi.fn(async () => ({ kind: 'hook' as const, effective: 'sync' as const, watchSeconds: 3000, access: null })),
    watch: vi.fn(async () => ({ kind: 'hook' as const, effective: 'sync' as const, watchSeconds: 3000, access: null })),
    ...overrides,
  };
}

describe('khala claude command registration', () => {
  it('fails closed when no Claude session client is composed', async () => {
    await expect(run(['claude', 'read', '--session', 's-1'])).resolves.toEqual({
      code: 2, out: '', err: '{"ok":false,"error":"transport_unavailable"}\n',
    });
  });

  it('rejects malformed invocations before any call', async () => {
    const composed = client();
    for (const argv of [
      ['claude'], ['claude', 'read'], ['claude', 'read', '--session'], ['claude', 'ack', '--session', 's-1'],
      ['claude', 'read', '--session', 's-1', '--ack', 'token'], ['claude', 'read', '--cwd', '/work'],
    ]) {
      await expect(run(argv, composed)).resolves.toMatchObject({ code: 2, err: '{"ok":false,"error":"invalid_arguments"}\n' });
    }
    expect(composed.read).not.toHaveBeenCalled();
    expect(composed.pull).not.toHaveBeenCalled();
  });

  it('writes the token-free batch frame, sends stdin bytes, and reports refusals', async () => {
    const composed = client({ read: vi.fn(async () => ({ kind: 'batch' as const, text: '<khala-channel-batch-v1>\n</khala-channel-batch-v1>' })) });
    await expect(run(['claude', 'read', '--session', 's-1'], composed)).resolves.toEqual({
      code: 0, out: '<khala-channel-batch-v1>\n</khala-channel-batch-v1>\n', err: '',
    });
    await expect(run(['claude', 'pull', '--session', 's-1'], composed)).resolves.toEqual({
      code: 0, out: '{"ok":true,"kind":"empty"}\n', err: '',
    });
    await expect(run(['claude', 'status', '--session', 's-1'], composed)).resolves.toEqual({
      code: 0, out: '{"ok":true,"kind":"status","acknowledged":2}\n', err: '',
    });
    // Hooks pull; the agent's read is a separate, acknowledging call.
    expect(composed.pull).toHaveBeenCalledTimes(1);
    expect(composed.read).toHaveBeenCalledTimes(1);
    await expect(run(['claude', 'send', '--session', 's-1'], composed, 'hello')).resolves.toMatchObject({ code: 0 });
    expect(composed.send).toHaveBeenCalledWith('s-1', 'hello', undefined);
    await expect(run(['claude', 'mode', '--session', 's-1'], composed)).resolves.toEqual({
      code: 3, out: '{"ok":false,"kind":"refused","code":"unproven"}\n', err: '',
    });
    await expect(run(['claude', 'pending', '--session', 's-1'], composed)).resolves.toEqual({
      code: 0, out: '{"ok":true,"kind":"pending"}\n', err: '',
    });
    await expect(run(['claude', 'hook', '--session', 's-1'], composed)).resolves.toEqual({
      code: 0, out: '{"ok":true,"kind":"hook","effective":"sync","watchSeconds":3000,"access":null}\n', err: '',
    });
  });

  it('exits 4 on an unknown send outcome so callers never retry it', async () => {
    const composed = client({ send: vi.fn(async () => ({ kind: 'outcome_unknown' as const, clientTxnId: 'txn-12345678' })) });
    await expect(run(['claude', 'send', '--session', 's-1'], composed, 'hello')).resolves.toEqual({
      code: 4, out: '{"ok":false,"kind":"outcome_unknown","clientTxnId":"txn-12345678"}\n', err: '',
    });
  });

  it('touches the shared registration files only to register the command', () => {
    const source = (file: string) => fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    const claudeLines = (file: string) => source(file).split('\n').filter(line => /claude/i.test(line));
    expect(claudeLines('../cli/app.ts')).toEqual([]);
    expect(claudeLines('../cli/registry.ts')).toEqual([
      "import { claudeCommand } from './commands/claude.js';",
      '  claudeCommand,',
    ]);
    expect(claudeLines('../cli/types.ts')).toEqual([
      "import type { ClaudeSessionClient } from '../composition/claude-session-http.js';",
      '  claude?: ClaudeSessionClient;',
    ]);
    expect(source('../mcp/server.ts')).not.toMatch(/claude/i);
  });
});
