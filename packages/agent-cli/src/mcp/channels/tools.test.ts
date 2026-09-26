import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../../cli/app.js';
import { PAGE, disconnectedStatus, listingClient } from '../../cli/channels/fixtures/listing.js';
import type { BatchInbox } from '../../cli/inbox.js';
import type { AgentClientPort } from '../../cli/types.js';

type ToolResponse = Readonly<{
  id: number;
  result?: Readonly<{
    tools?: readonly Readonly<{ name: string; inputSchema: Readonly<Record<string, unknown>> }>[];
    content?: readonly Readonly<{ type: string; text: string }>[];
    structuredContent?: unknown;
    isError?: boolean;
  }>;
  error?: Readonly<{ code: number; message: string }>;
}>;

function idleInbox(): BatchInbox {
  return {
    async enqueue() { return 'appended'; },
    async acquireListener() { return { async readBatch() { return null; }, async release() {} }; },
    async readNext() { return null; },
    async acknowledge() {},
    async status() { return { bindingId: 'binding-1', generation: 0, cursor: { v: 1, offset: 0, releaseId: null } }; },
  } as unknown as BatchInbox;
}

async function mcp(client: AgentClientPort, requests: readonly Record<string, unknown>[]): Promise<ToolResponse[]> {
  const stdout = new PassThrough(); const stderr = new PassThrough(); let out = '';
  stdout.on('data', chunk => { out += String(chunk); });
  const stdin = Readable.from([requests.map(item => JSON.stringify(item) + '\n').join('')]);
  expect(await runCli(['mcp-serve'], { client, inbox: async () => idleInbox(), stdin, stdout, stderr })).toBe(0);
  return out.trim().split('\n').map(line => JSON.parse(line) as ToolResponse);
}

async function cli(client: AgentClientPort, argv: readonly string[]): Promise<Readonly<{ code: number; output: unknown }>> {
  const stdin = new PassThrough(); stdin.end();
  const stdout = new PassThrough(); const stderr = new PassThrough(); let out = '';
  stdout.on('data', chunk => { out += String(chunk); });
  const code = await runCli(argv, { client, inbox: async () => idleInbox(), stdin, stdout, stderr });
  return { code, output: JSON.parse(out) };
}

function call(id: number, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

describe('MCP channel listing tools', () => {
  it('advertises strict schemas for khala_list_channels and khala_list_agents', async () => {
    const [response] = await mcp(listingClient(), [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
    const tools = response?.result?.tools ?? [];
    expect(tools.map(tool => tool.name)).toEqual(['khala_send', 'khala_read', 'khala_list_channels', 'khala_list_agents']);
    expect(tools[2]?.inputSchema).toMatchObject({
      type: 'object', required: [], additionalProperties: false,
      properties: { origin: { type: 'string' }, cursor: { type: 'string' }, ackBatchToken: { type: 'string' } },
    });
    expect(tools[3]?.inputSchema).toMatchObject({
      type: 'object', required: ['channel'], additionalProperties: false,
      properties: { channel: { type: 'string' }, ackBatchToken: { type: 'string' } },
    });
  });

  it('rejects a khala_list_channels result carrying server-only roomId, roster, or activity', async () => {
    const leaky = {
      ...PAGE,
      items: [{ ...PAGE.items[0], roomId: '!secret:matrix.example', roster: ['agent-9'], lastActivityAt: '2026-09-25T00:00:00Z' }],
    };
    const [response] = await mcp(listingClient({ async listChannels() { return { kind: 'listed', page: leaky }; } }), [
      call(1, 'khala_list_channels', {}),
    ]);
    expect(response?.result).toEqual({
      content: [{ type: 'text', text: '{"ok":false,"error":"unavailable"}' }],
      structuredContent: { ok: false, error: 'unavailable' },
      isError: true,
    });
    const serialized = JSON.stringify(response);
    for (const leaked of ['!secret:matrix.example', 'agent-9', 'lastActivityAt']) expect(serialized).not.toContain(leaked);
  });

  it('passes the cursor and origin through and returns the page', async () => {
    const listChannels = vi.fn<AgentClientPort['listChannels']>(async () => ({ kind: 'listed', page: PAGE }));
    const [response] = await mcp(listingClient({ listChannels }), [
      call(1, 'khala_list_channels', { origin: 'https://khala.aiur.team', cursor: 'cursor-2' }),
    ]);
    expect(listChannels).toHaveBeenCalledWith({ origin: 'https://khala.aiur.team', cursor: 'cursor-2' }, undefined);
    expect(response?.result?.structuredContent).toMatchObject({ ok: true, nextCursor: 'cursor-2' });
    expect(response?.result?.isError).toBeUndefined();
  });

  it.each([
    ['khala_list_channels', { origin: 'https://khala.aiur.team/x' }],
    ['khala_list_channels', { origin: 'http://khala.aiur.team' }],
    ['khala_list_channels', { cursor: '' }],
    ['khala_list_channels', { cursor: 7 }],
    ['khala_list_channels', { limit: 5 }],
    ['khala_list_channels', { ackBatchToken: 3 }],
    ['khala_list_agents', {}],
    ['khala_list_agents', { channel: '' }],
    ['khala_list_agents', { channel: 'binding-1', bindingId: 'binding-1' }],
  ])('refuses %s with %j as invalid params', async (name, args) => {
    const listChannels = vi.fn<AgentClientPort['listChannels']>();
    const listAgents = vi.fn<AgentClientPort['listAgents']>();
    const [response] = await mcp(listingClient({ listChannels, listAgents }), [call(1, name, args)]);
    expect(response?.error).toEqual({ code: -32602, message: 'Invalid params' });
    expect(listChannels).not.toHaveBeenCalled();
    expect(listAgents).not.toHaveBeenCalled();
  });

  it('ignores listing tool notifications without calling the service', async () => {
    const listChannels = vi.fn<AgentClientPort['listChannels']>();
    const listAgents = vi.fn<AgentClientPort['listAgents']>();
    const responses = await mcp(listingClient({ listChannels, listAgents }), [
      { jsonrpc: '2.0', method: 'tools/call', params: { name: 'khala_list_channels', arguments: {} } },
      { jsonrpc: '2.0', method: 'tools/call', params: { name: 'khala_list_agents', arguments: { channel: 'binding-1' } } },
      { jsonrpc: '2.0', id: 1, method: 'ping' },
    ]);
    expect(responses).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);
    expect(listChannels).not.toHaveBeenCalled();
    expect(listAgents).not.toHaveBeenCalled();
  });

  it('accepts an ackBatchToken alongside listing arguments', async () => {
    const [response] = await mcp(listingClient(), [call(1, 'khala_list_agents', { channel: 'binding-1', ackBatchToken: 'token-1' })]);
    expect(response?.result?.structuredContent).toMatchObject({ ok: true, channel: 'binding-1' });
  });
});

describe('CLI and MCP parity', () => {
  const channelCases: readonly (readonly [string, Partial<AgentClientPort>])[] = [
    ['page', {}],
    ['refusal', { async listChannels() { return { kind: 'refused', code: 'rate_limited' }; } }],
    ['unavailable', { async listChannels() { return { kind: 'unavailable' }; } }],
    ['leaky page', { async listChannels() { return { kind: 'listed', page: { ...PAGE, total: 9 } }; } }],
  ];
  it.each(channelCases)('prints the same channel projection for %s', async (_label, overrides) => {
    const client = listingClient(overrides);
    const cliResult = await cli(client, ['channels', 'list', '--cursor', 'cursor-1']);
    const [response] = await mcp(client, [call(1, 'khala_list_channels', { cursor: 'cursor-1' })]);
    expect(response?.result?.structuredContent).toEqual(cliResult.output);
    expect(JSON.parse(response?.result?.content?.[0]?.text ?? 'null')).toEqual(cliResult.output);
    expect(response?.result?.isError === true).toBe(cliResult.code !== 0);
  });

  const agentCases: readonly (readonly [string, string, Partial<AgentClientPort>])[] = [
    ['roster', 'binding-1', {}],
    ['unheld channel', 'binding-other', {}],
    ['server not_joined', 'binding-1', { async listAgents() { return { kind: 'refused', code: 'not_joined' }; } }],
    ['unavailable', 'binding-1', { async listAgents() { return { kind: 'unavailable' }; } }],
  ];
  it.each(agentCases)('prints the same agent projection for %s', async (_label, channel, overrides) => {
    const client = listingClient(overrides);
    const cliResult = await cli(client, ['agents', 'list', '--channel', channel]);
    const [response] = await mcp(client, [call(1, 'khala_list_agents', { channel })]);
    expect(response?.result?.structuredContent).toEqual(cliResult.output);
    expect(response?.result?.isError === true).toBe(cliResult.code !== 0);
  });

  it('reports not_connected identically once the binding is lost mid-session', async () => {
    let statusCalls = 0;
    const client = listingClient({
      async status() { return statusCalls++ === 0 ? listingClient().status() : disconnectedStatus(); },
    });
    const [response] = await mcp(client, [call(1, 'khala_list_agents', { channel: 'binding-1' })]);
    expect(response?.result?.structuredContent).toEqual({ ok: false, error: 'not_connected' });
    const disconnected = await cli(listingClient({ async status() { return disconnectedStatus(); } }), [
      'agents', 'list', '--channel', 'binding-1',
    ]);
    expect(disconnected.output).toEqual(response?.result?.structuredContent);
  });
});
