import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../cli/app.js';
import { listingClient } from '../cli/channels/fixtures/listing.js';
import type { BatchInbox } from '../cli/inbox.js';
import type { AgentClientPort, PairResult } from '../cli/types.js';

type ToolResponse = Readonly<{
  id: number;
  result?: Readonly<{
    tools?: readonly Readonly<{ name: string; description: string; inputSchema: Readonly<Record<string, unknown>> }>[];
    content?: readonly Readonly<{ type: string; text: string }>[];
    structuredContent?: unknown;
    isError?: boolean;
  }>;
  error?: Readonly<{ code: number; message: string }>;
}>;

const BINDING = {
  v: 1, bindingId: 'bnd_1', ownerId: 'owner_b', agentParticipantId: 'agent_b', deviceId: 'KHALADEV1',
  harness: 'codex', sessionId: 'thread-existing-b', generation: 3,
};

/** An inbox that fails the test if a pairing call ever touches it. */
function untouchedInbox(): BatchInbox {
  const fail = () => { throw new Error('pairing must not use the inbox'); };
  return {
    enqueue: fail, acquireListener: fail, readNext: fail, acknowledge: fail,
    async status() { return { bindingId: 'binding-1', generation: 0, cursor: { v: 1, offset: 0, releaseId: null } }; },
  } as unknown as BatchInbox;
}

async function mcp(client: AgentClientPort, requests: readonly Record<string, unknown>[]): Promise<ToolResponse[]> {
  const stdout = new PassThrough(); const stderr = new PassThrough(); let out = '';
  stdout.on('data', chunk => { out += String(chunk); });
  const stdin = Readable.from([requests.map(item => JSON.stringify(item) + '\n').join('')]);
  expect(await runCli(['mcp-serve'], { client, inbox: async () => untouchedInbox(), stdin, stdout, stderr })).toBe(0);
  const text = out.trim();
  return text === '' ? [] : text.split('\n').map(line => JSON.parse(line) as ToolResponse);
}

async function cli(client: AgentClientPort, code: string): Promise<unknown> {
  const stdin = new PassThrough(); stdin.end();
  const stdout = new PassThrough(); const stderr = new PassThrough(); let out = '';
  stdout.on('data', chunk => { out += String(chunk); });
  await runCli(['pair', code], { client, inbox: async () => untouchedInbox(), stdin, stdout, stderr });
  return JSON.parse(out);
}

function call(id: number, args: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'khala_pair', arguments: args } };
}

describe('khala_pair', () => {
  it('advertises a strict schema with only the code and no batch token', async () => {
    const [response] = await mcp(listingClient(), [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
    const tool = response?.result?.tools?.find(entry => entry.name === 'khala_pair');
    expect(tool?.inputSchema).toEqual({
      type: 'object', required: ['code'], additionalProperties: false,
      properties: { code: { type: 'string', description: expect.any(String) } },
    });
  });

  it('AE7: returns exactly the CLI object for every finite result', async () => {
    const results: PairResult[] = [
      { kind: 'connected', binding: BINDING as never, reused: true },
      { kind: 'refused', code: 'pairing_refused' },
      { kind: 'refused', code: 'pairing_denied' },
      { kind: 'refused', code: 'pairing_expired' },
      { kind: 'refused', code: 'rate_limited' },
      { kind: 'refused', code: 'operation_conflict' },
      { kind: 'pending', reason: 'approval_timeout' },
      { kind: 'pending', reason: 'cancelled' },
      { kind: 'unavailable' },
    ];
    for (const result of results) {
      const client = listingClient({ pair: async () => result });
      const [response] = await mcp(client, [call(1, { code: '7k3qx-9mz2p' })]);
      const expected = await cli(client, '7k3qx-9mz2p');
      expect(response?.result?.structuredContent).toEqual(expected);
      expect(JSON.parse(response?.result?.content?.[0]?.text ?? 'null')).toEqual(expected);
      expect(response?.result?.isError ?? false).toBe(result.kind !== 'connected');
    }
    // A malformed code and a missing configuration match too.
    const [invalid] = await mcp(listingClient({ pair: async () => ({ kind: 'unavailable' }) }), [call(1, { code: 'nope' })]);
    expect(invalid?.result?.structuredContent).toEqual(await cli(listingClient(), 'nope'));
    const [unconfigured] = await mcp(listingClient(), [call(1, { code: '7K3QX-9MZ2P' })]);
    expect(unconfigured?.result?.structuredContent).toEqual({ ok: false, v: 1, error: 'pairing_unavailable' });
  });

  it('rejects unknown fields, a batch token and non-string codes as invalid params without pairing', async () => {
    const pair = vi.fn<NonNullable<AgentClientPort['pair']>>(async () => ({ kind: 'unavailable' }));
    const responses = await mcp(listingClient({ pair }), [
      call(1, { code: '7K3QX-9MZ2P', channel: 'room-1' }),
      call(2, { code: '7K3QX-9MZ2P', ackBatchToken: 'token' }),
      call(3, { code: 42 }),
      call(4, {}),
    ]);
    expect(responses.map(response => response.error?.code)).toEqual([-32602, -32602, -32602, -32602]);
    expect(pair).not.toHaveBeenCalled();
  });

  it('never starts a claim for a notification', async () => {
    const pair = vi.fn<NonNullable<AgentClientPort['pair']>>(async () => ({ kind: 'unavailable' }));
    const notification = call(1, { code: '7K3QX-9MZ2P' });
    delete notification.id;
    expect(await mcp(listingClient({ pair }), [notification])).toEqual([]);
    expect(pair).not.toHaveBeenCalled();
  });
});
