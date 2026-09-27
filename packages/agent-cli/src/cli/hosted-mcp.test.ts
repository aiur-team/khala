import { PassThrough, Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from './app.js';
import { createUnavailableClient } from '../composition/unavailable.js';
import type { InternalDelivery } from '../composition/internal-delivery.js';
import type { CliDependencies } from './types.js';
import { openInbox } from './inbox.js';
import { decodeSessionBinding } from '@khala/contracts/delivery/index';

const THREAD = '01a0b66b-ce0c-7ee3-823e-14ecdb9f2856';
const CODE = '7K3QX-9MZ2P';
const unavailableDelivery: InternalDelivery = {
  async pull() { return 'unavailable'; },
  async acknowledge() { throw new Error('unbound pairing must not acknowledge'); },
  async issueBatch() { throw new Error('unbound pairing must not issue a batch'); },
};

function call(id: number, name: string, meta: Record<string, unknown> | undefined, args?: Record<string, unknown>) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: {
    name, arguments: args ?? (name === 'khala_pair' ? { code: CODE } : {}),
    ...(meta === undefined ? {} : { _meta: meta }),
  } };
}

async function serve(requests: readonly ReturnType<typeof call>[], hostedSession: NonNullable<CliDependencies['hostedSession']>,
  hostedBindingPresent?: NonNullable<CliDependencies['hostedBindingPresent']>) {
  const stdout = new PassThrough(); const stderr = new PassThrough(); let output = '';
  stdout.on('data', chunk => { output += String(chunk); });
  const stdin = Readable.from([requests.map(request => `${JSON.stringify(request)}\n`).join('')]);
  expect(await runCli(['mcp-serve'], {
    client: createUnavailableClient(),
    inbox: async () => { throw new Error('unbound route must not open inbox'); },
    stdin, stdout, stderr,
    sessionGrants: session => `/unbound/${session.harness}/${session.sessionId}/grant.json`,
    internalClient: async () => createUnavailableClient(),
    internalDelivery: async () => unavailableDelivery,
    hostedSession,
    ...(hostedBindingPresent ? { hostedBindingPresent } : {}),
  })).toBe(0);
  return output.trim().split('\n').map(line => JSON.parse(line) as { result: { structuredContent: unknown } });
}

describe('installed hosted MCP routing', () => {
  it('pairs only the provider-named Codex session, never an unbound read or unnamed session', async () => {
    const close = vi.fn(async () => undefined);
    const pair = vi.fn(async () => ({ kind: 'pending' as const, reason: 'approval_timeout' as const }));
    const hostedSession = vi.fn(async () => ({
      client: { ...createUnavailableClient(), pair },
      inbox: async () => { throw new Error('unbound route must not open hosted inbox'); }, close,
    }));
    const hostedBindingPresent = vi.fn(async () => false);
    const replies = await serve([
      call(1, 'khala_pair', undefined),
      call(2, 'khala_read', { threadId: THREAD }),
      call(3, 'khala_pair', { threadId: THREAD }),
      call(4, 'khala_pair', { threadId: THREAD }),
    ], hostedSession, hostedBindingPresent);
    expect(replies[0]?.result.structuredContent).toEqual({ kind: 'refused', code: 'not_connected' });
    expect(replies[1]?.result.structuredContent).toEqual({ kind: 'refused', code: 'not_connected' });
    expect(replies[2]?.result.structuredContent).toEqual({ ok: false, v: 1, error: 'approval_pending', reason: 'approval_timeout', retryable: true });
    expect(replies[3]?.result.structuredContent).toEqual(replies[2]?.result.structuredContent);
    expect(hostedSession).toHaveBeenCalledExactlyOnceWith({ harness: 'codex', sessionId: THREAD });
    expect(hostedBindingPresent).toHaveBeenCalledExactlyOnceWith({ harness: 'codex', sessionId: THREAD });
    expect(pair).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
  });

  it('uses the newly admitted hosted binding only for its exact provider session', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khala-hosted-mcp-'));
    try {
      const decoded = decodeSessionBinding({
        v: 1 as const, bindingId: 'binding-hosted', ownerId: 'owner-1', agentParticipantId: 'agent-1',
        deviceId: 'KHALADEV1', harness: 'codex', sessionId: THREAD, generation: 0,
      });
      if (!decoded.ok) throw new Error('invalid binding fixture');
      const binding = decoded.value;
      let admitted = false;
      const send = vi.fn(async (input: { clientTxnId: string }) => ({ kind: 'accepted' as const,
        clientTxnId: input.clientTxnId, eventId: 'event-1' }));
      const openedInbox = vi.fn(async (bindingId: string, generation: number) => openInbox({
        stateDirectory: root, bindingId, generation, maxPayloadBytes: 4096, maxSelectionEvents: 8,
      }));
      const hostedSession = vi.fn(async () => ({
        client: {
          ...createUnavailableClient(),
          async pair() { admitted = true; return { kind: 'connected' as const, binding, reused: false }; },
          async status() { return admitted
            ? { v: 1 as const, connected: true, binding, route: 'native_cli_queue' as const, sourceCursor: null }
            : { v: 1 as const, connected: false, binding: null, route: 'unavailable' as const, sourceCursor: null }; },
          send,
        },
        inbox: openedInbox,
        async close() {},
      }));
      const replies = await serve([
        call(1, 'khala_pair', { threadId: THREAD }),
        call(2, 'khala_send', { threadId: THREAD }, { message: 'bound message' }),
        call(3, 'khala_send', { threadId: 'another-thread' }, { message: 'must refuse' }),
      ], hostedSession);
      expect(replies[0]?.result.structuredContent).toMatchObject({ ok: true, binding });
      expect(replies[1]?.result.structuredContent).toMatchObject({ kind: 'accepted', eventId: 'event-1' });
      expect(replies[2]?.result.structuredContent).toEqual({ kind: 'refused', code: 'not_connected' });
      expect(send).toHaveBeenCalledOnce();
      expect(openedInbox).toHaveBeenCalledExactlyOnceWith(binding.bindingId, binding.generation);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('routes an HTTPS link through the same provider-named unbound session', async () => {
    const link = 'https://khala.aiur.team/i/example';
    const connect = vi.fn(async () => ({ kind: 'refused' as const, code: 'ownership_required' as const }));
    const hostedSession = vi.fn(async () => ({
      client: { ...createUnavailableClient(), connect },
      inbox: async () => { throw new Error('unbound link must not open inbox'); },
      async close() {},
    }));
    const replies = await serve([
      call(1, 'khala_connect', undefined, { url: link }),
      call(2, 'khala_connect', { threadId: THREAD }, { url: 'http://wrong.example/i/x' }),
      call(3, 'khala_connect', { threadId: THREAD }, { url: link }),
    ], hostedSession);
    expect(replies[0]?.result.structuredContent).toEqual({ kind: 'refused', code: 'not_connected' });
    expect(replies[1]?.result.structuredContent).toEqual({ ok: false, error: 'invalid_link' });
    expect(replies[2]?.result.structuredContent).toEqual({ ok: false, error: 'ownership_required' });
    expect(connect).toHaveBeenCalledExactlyOnceWith(link, undefined);
    expect(hostedSession).toHaveBeenCalledExactlyOnceWith({ harness: 'codex', sessionId: THREAD });
  });
});
