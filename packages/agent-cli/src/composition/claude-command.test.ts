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
    read: vi.fn(async () => ({ kind: 'empty' as const })),
    send: vi.fn(async () => ({ kind: 'accepted' as const, clientTxnId: 'txn-12345678', eventId: null })),
    mode: vi.fn(async () => ({ kind: 'refused' as const, code: 'unproven' as const })),
    pending: vi.fn(async () => ({ kind: 'pending' as const })),
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
  });

  it('writes the token-free batch frame, sends stdin bytes, and reports refusals', async () => {
    const composed = client({ read: vi.fn(async () => ({ kind: 'batch' as const, text: '<khala-channel-batch-v1>\n</khala-channel-batch-v1>' })) });
    await expect(run(['claude', 'read', '--session', 's-1'], composed)).resolves.toEqual({
      code: 0, out: '<khala-channel-batch-v1>\n</khala-channel-batch-v1>\n', err: '',
    });
    await expect(run(['claude', 'send', '--session', 's-1'], composed, 'hello')).resolves.toMatchObject({ code: 0 });
    expect(composed.send).toHaveBeenCalledWith('s-1', 'hello', undefined);
    await expect(run(['claude', 'mode', '--session', 's-1'], composed)).resolves.toEqual({
      code: 3, out: '{"ok":false,"kind":"refused","code":"unproven"}\n', err: '',
    });
    await expect(run(['claude', 'pending', '--session', 's-1'], composed)).resolves.toEqual({
      code: 0, out: '{"ok":true,"kind":"pending"}\n', err: '',
    });
  });

  it('exits 4 on an unknown send outcome so callers never retry it', async () => {
    const composed = client({ send: vi.fn(async () => ({ kind: 'outcome_unknown' as const, clientTxnId: 'txn-12345678' })) });
    await expect(run(['claude', 'send', '--session', 's-1'], composed, 'hello')).resolves.toEqual({
      code: 4, out: '{"ok":false,"kind":"outcome_unknown","clientTxnId":"txn-12345678"}\n', err: '',
    });
  });

  it('touches the shared registration files only to register the command', () => {
    const app = fs.readFileSync(new URL('../cli/app.ts', import.meta.url), 'utf8');
    const server = fs.readFileSync(new URL('../mcp/server.ts', import.meta.url), 'utf8');
    expect(app.split('\n').filter(line => /claude/i.test(line))).toEqual([
      "import { runClaudeCommand } from '../composition/claude-command.js';",
      "import type { ClaudeSessionClient } from '../composition/claude-session-http.js';",
      '  claude?: ClaudeSessionClient;',
      "      case 'claude': return await runClaudeCommand(args, { ...deps, readStdin });",
    ]);
    expect(server).not.toMatch(/claude/i);
  });
});
