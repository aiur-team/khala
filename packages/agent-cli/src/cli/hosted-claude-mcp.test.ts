import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { decodeSessionBinding, type EventRef } from '@khala/contracts/delivery/index';
import { runCli } from './app.js';
import { openInbox } from './inbox.js';
import type { CliDependencies } from './types.js';
import { createUnavailableClient } from '../composition/unavailable.js';

const SESSION = 'native-claude-571';
const PROOF_SESSION = `agent_${'A'.repeat(43)}`;
const binding = (() => {
  const decoded = decodeSessionBinding({ v: 1, bindingId: 'binding-571', ownerId: 'owner-571',
    agentParticipantId: 'agent-571', deviceId: 'DEVICE571', harness: 'proof-key',
    sessionId: PROOF_SESSION, generation: 2 });
  if (!decoded.ok) throw new Error('invalid test binding');
  return decoded.value;
})();

function request(id: number, name: string, args: Record<string, unknown> = {}) {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`;
}

async function serve(factory: NonNullable<CliDependencies['hostedSession']>, calls: string[], sessionId = SESSION) {
  const stdout = new PassThrough();
  let output = '';
  stdout.on('data', chunk => { output += String(chunk); });
  const code = await runCli(['mcp-serve'], {
    client: createUnavailableClient(),
    inbox: async () => { throw new Error('unbound inbox'); },
    stdin: Readable.from(calls), stdout, stderr: new PassThrough(),
    env: { KHALA_MCP_HARNESS: 'claude', CLAUDE_CODE_SESSION_ID: sessionId },
    hostedSession: factory,
  });
  expect(code).toBe(0);
  return output.trim().split('\n').map(line => JSON.parse(line) as {
    result: { structuredContent: Record<string, unknown>; isError?: boolean };
  });
}

describe('hosted native Claude MCP', () => {
  it('scopes default hosted access operations to each Claude session', async () => {
    const operations: string[] = [];
    const factory: NonNullable<CliDependencies['hostedSession']> = async () => ({
      client: { ...createUnavailableClient(), async requestChannelAccess(input) {
        operations.push(input.operationId);
        return { kind: 'status', status: { v: 1, operationId: input.operationId, outcome: 'pending_owner' } };
      } },
      inbox: async () => { throw new Error('unbound'); }, async close() {},
    });
    const call = request(1, 'khala_request_channel_access', { target: 'https://khala.aiur.team/channels/room-571' });
    await serve(factory, [call], SESSION);
    await serve(factory, [call], 'other-claude-571');
    expect(operations).toHaveLength(2);
    expect(operations[0]).not.toBe(operations[1]);
  });

  it('reads and sends only after approval through the held proof-key binding, including after restart', async () => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-claude-hosted-'));
    try {
      const bytes = new TextEncoder().encode('{"body":"encrypted release 571"}');
      const digest = (value: Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
      const inbox = await openInbox({ stateDirectory: root, bindingId: binding.bindingId,
        generation: binding.generation, maxPayloadBytes: 4096, maxSelectionEvents: 8 });
      await inbox.enqueue({ v: 1, releaseId: 'release-571', bindingId: binding.bindingId,
        generation: binding.generation, events: [{ v: 1, roomId: 'room-571' as EventRef['roomId'],
          eventId: 'event-571' as EventRef['eventId'], authorParticipantId: 'sender-571' as EventRef['authorParticipantId'],
          authorDeviceId: 'device-571' as EventRef['authorDeviceId'], contentDigest: digest(bytes) }],
        payloadDigest: digest(bytes), payload: bytes, receivedAt: '2026-09-29T12:00:00Z' });
      let approved = false;
      const send = vi.fn(async (input: { bindingId: string | null; clientTxnId: string }) => ({
        kind: 'accepted' as const, clientTxnId: input.clientTxnId, eventId: 'event-sent-571',
      }));
      const factory = vi.fn(async () => ({
        client: { ...createUnavailableClient(), storedSessionId: () => PROOF_SESSION,
          async status() { return { v: 1 as const, connected: approved, binding: approved ? binding : null,
            route: 'native_cli_queue' as const, sourceCursor: null }; }, send },
        inbox: async () => openInbox({ stateDirectory: root, bindingId: binding.bindingId,
          generation: binding.generation, maxPayloadBytes: 4096, maxSelectionEvents: 8 }),
        async close() {},
      }));
      const pending = await serve(factory, [request(1, 'khala_status'), request(2, 'khala_read'),
        request(3, 'khala_send', { message: 'before approval' })]);
      expect(pending.map(reply => reply.result.structuredContent)).toEqual(Array(3).fill({ kind: 'refused', code: 'not_connected' }));
      expect(send).not.toHaveBeenCalled();
      approved = true;
      const admitted = await serve(factory, [request(1, 'khala_status'), request(2, 'khala_read'),
        request(3, 'khala_send', { message: 'one encrypted send' })]);
      expect(admitted[0]?.result.structuredContent).toEqual({ kind: 'status', connected: true });
      expect(admitted[1]?.result.structuredContent).toMatchObject({ kind: 'batch', batch: expect.stringContaining('encrypted release 571') });
      expect(JSON.stringify(admitted)).not.toContain('batchToken');
      expect(admitted[2]?.result.structuredContent).toMatchObject({ kind: 'accepted', eventId: 'event-sent-571' });
      expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ bindingId: binding.bindingId,
        body: 'one encrypted send' }), undefined);
      const restarted = await serve(factory, [request(4, 'khala_read')]);
      expect(restarted[0]?.result.structuredContent).toMatchObject({ kind: 'batch' });
      expect(factory).toHaveBeenCalledWith({ harness: 'claude', sessionId: SESSION });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['wrong-session', 'wrong-device'])('refuses a %s binding during delivery', async mismatch => {
    const wrong = mismatch === 'wrong-session' ? { ...binding, sessionId: 'agent_other' }
      : { ...binding, deviceId: 'OTHERDEVICE' as typeof binding.deviceId };
    const send = vi.fn();
    let checks = 0;
    const factory: NonNullable<CliDependencies['hostedSession']> = async () => ({
      client: { ...createUnavailableClient(), storedSessionId: () => PROOF_SESSION,
        async status() { return { v: 1, connected: true, binding: checks++ === 0 ? binding : wrong,
          route: 'native_cli_queue', sourceCursor: null }; }, send },
      inbox: async () => ({ acquireCallConsumer: async () => ({ readBatch: async () => null, release: async () => {} }) }) as never,
      async close() {},
    });
    const results = await serve(factory, [request(1, 'khala_read'), request(2, 'khala_send', { message: 'x' })]);
    expect(results[0]?.result.structuredContent).toEqual({ kind: 'refused', code: 'binding_not_held' });
    expect(results[1]?.result.structuredContent).toEqual({ kind: 'refused', code: 'not_connected' });
    expect(send).not.toHaveBeenCalled();
  });
});
