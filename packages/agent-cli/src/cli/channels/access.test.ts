import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { ACCESS_REQUEST_OUTCOMES } from '@khala/contracts/messaging/index';
import { runCli } from '../app.js';
import type { BatchInbox } from '../inbox.js';
import type { AgentClientPort } from '../types.js';
import { defaultOperationId, parseAccessTarget } from './access.js';
import { listingClient } from './fixtures/listing.js';
import type { ChannelAccessResult } from './types.js';

const URL_TARGET = 'https://khala.aiur.team/channels/channel-1';

function status(operationId: string, outcome: string, extra: Record<string, unknown> = {}): ChannelAccessResult {
  return { kind: 'status', status: { v: 1, operationId, outcome, ...extra } };
}

function accessClient(overrides: Partial<AgentClientPort> = {}): AgentClientPort {
  return {
    ...listingClient(),
    requestChannelAccess: async input => status(input.operationId, 'pending_owner'),
    channelAccessStatus: async input => status(input.operationId, 'pending_owner'),
    ...overrides,
  };
}

function idleInbox(): BatchInbox {
  return {
    async enqueue() { return 'appended'; },
    async acquireListener() { return { async readBatch() { return null; }, async release() {} }; },
    async readNext() { return null; },
    async acknowledge() {},
    async status() { return { bindingId: 'binding-1', generation: 0, cursor: { v: 1, offset: 0, releaseId: null } }; },
  } as unknown as BatchInbox;
}

async function cli(client: AgentClientPort, argv: readonly string[]) {
  const stdin = new PassThrough(); stdin.end();
  const stdout = new PassThrough(); const stderr = new PassThrough(); let out = ''; let err = '';
  stdout.on('data', chunk => { out += String(chunk); }); stderr.on('data', chunk => { err += String(chunk); });
  const code = await runCli(argv, { client, inbox: async () => idleInbox(), stdin, stdout, stderr });
  return { code, out, err, json: () => JSON.parse(out) as Record<string, unknown> };
}

async function mcpCall(client: AgentClientPort, name: string, args: Record<string, unknown>) {
  const stdout = new PassThrough(); const stderr = new PassThrough(); let out = '';
  stdout.on('data', chunk => { out += String(chunk); });
  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
  ];
  const stdin = Readable.from([lines.map(line => JSON.stringify(line) + '\n').join('')]);
  await runCli(['mcp-serve'], { client, inbox: async () => idleInbox(), stdin, stdout, stderr });
  const [list, result] = out.trim().split('\n').map(line => JSON.parse(line));
  return { tools: list.result.tools as { name: string; inputSchema: Record<string, unknown> }[], result };
}

describe('khala channels request-access', () => {
  it('returns pending with a stable operation ID and passes a channel URL through', async () => {
    const requestChannelAccess = vi.fn<NonNullable<AgentClientPort['requestChannelAccess']>>(
      async input => status(input.operationId, 'pending_owner'),
    );
    const first = await cli(accessClient({ requestChannelAccess }), ['channels', 'request-access', URL_TARGET]);
    const second = await cli(accessClient({ requestChannelAccess }), ['channels', 'request-access', URL_TARGET]);
    const operationId = defaultOperationId({ kind: 'channel_url', channelUrl: URL_TARGET });
    expect(first.code).toBe(0);
    expect(first.json()).toEqual({ ok: true, v: 1, operationId, outcome: 'pending_owner', next: null });
    expect(second.json()).toEqual(first.json());
    expect(requestChannelAccess).toHaveBeenCalledWith(
      { target: { kind: 'channel_url', channelUrl: URL_TARGET }, operationId, origin: null }, undefined,
    );
  });

  it('passes a listing reference, explicit operation, and origin through', async () => {
    const requestChannelAccess = vi.fn<NonNullable<AgentClientPort['requestChannelAccess']>>(
      async input => status(input.operationId, 'pending_owner'),
    );
    const result = await cli(
      accessClient({ requestChannelAccess }),
      ['channels', 'request-access', 'ref-alpha', '--operation', 'op-1', '--origin', 'https://khala.aiur.team'],
    );
    expect(result.code).toBe(0);
    expect(requestChannelAccess).toHaveBeenCalledWith(
      { target: { kind: 'listing_ref', listingRef: 'ref-alpha' }, operationId: 'op-1', origin: 'https://khala.aiur.team' }, undefined,
    );
  });

  it.each([
    [['channels', 'request-access']],
    [['channels', 'request-access', '']],
    [['channels', 'request-access', 'https://khala.aiur.team/channels/c?x=1']],
    [['channels', 'request-access', 'https://user:pw@khala.aiur.team/channels/c']],
    [['channels', 'request-access', 'http://khala.aiur.team/channels/c']],
    [['channels', 'request-access', 'ref', '--operation']],
    [['channels', 'request-access', 'ref', '--operation', 'a', '--operation', 'b']],
    [['channels', 'request-access', 'ref', '--origin', 'https://khala.aiur.team/x']],
    [['channels', 'access-status']],
    [['channels', 'access-status', '--origin', 'https://khala.aiur.team']],
  ])('rejects %j before calling the client', async argv => {
    const requestChannelAccess = vi.fn(); const channelAccessStatus = vi.fn();
    const result = await cli(accessClient({ requestChannelAccess, channelAccessStatus }), argv);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.err)).toEqual({ ok: false, error: 'invalid_arguments' });
    expect(requestChannelAccess).not.toHaveBeenCalled();
    expect(channelAccessStatus).not.toHaveBeenCalled();
  });

  it.each([
    ['pending_owner', 0, null], ['approved', 0, null], ['connecting', 0, null], ['connected', 0, null],
    ['denied', 3, null], ['expired', 3, null], ['revoked', 3, null],
    ['repair_required', 3, 'repair_connector'], ['unavailable', 4, 'reuse_operation_id'],
  ])('reports %s with exit %i and next %s', async (outcome, code, next) => {
    const result = await cli(
      accessClient({ channelAccessStatus: async input => status(input.operationId, outcome) }),
      ['channels', 'access-status', '--operation', 'op-1'],
    );
    expect(result.code).toBe(code);
    expect(result.json()).toEqual({ ok: true, v: 1, operationId: 'op-1', outcome, next });
  });

  it('covers every contract outcome', () => {
    expect(ACCESS_REQUEST_OUTCOMES).toHaveLength(9);
  });

  it.each([
    ['extra field', status('op-1', 'pending_owner', { roomId: '!room:matrix' })],
    ['unknown outcome', status('op-1', 'admitted')],
    ['missing outcome', { kind: 'status', status: { v: 1, operationId: 'op-1' } }],
    ['other operation', status('op-2', 'connected')],
    ['not an object', { kind: 'status', status: 'connected' }],
    ['unknown kind', { kind: 'mystery' }],
  ])('treats a malformed status (%s) as unavailable, never forwarding it', async (_name, reply) => {
    const result = await cli(
      accessClient({ channelAccessStatus: async () => reply as ChannelAccessResult }),
      ['channels', 'access-status', '--operation', 'op-1'],
    );
    expect(result.code).toBe(4);
    expect(result.json()).toEqual({ ok: false, v: 1, error: 'unavailable', operationId: 'op-1', next: 'reuse_operation_id' });
    expect(result.out).not.toContain('roomId');
  });

  it('reports a cross-origin redirect refusal', async () => {
    const result = await cli(
      accessClient({ requestChannelAccess: async () => ({ kind: 'refused', code: 'untrusted_origin' }) }),
      ['channels', 'request-access', URL_TARGET, '--operation', 'op-1'],
    );
    expect(result.code).toBe(3);
    expect(result.json()).toEqual({ ok: false, v: 1, error: 'untrusted_origin', operationId: 'op-1', next: null });
  });

  it('is unavailable when no access client is composed', async () => {
    const result = await cli(listingClient(), ['channels', 'request-access', 'ref-alpha', '--operation', 'op-1']);
    expect(result.code).toBe(4);
    expect(result.json().error).toBe('unavailable');
  });

  // Wrong-implementation test: an `unavailable` result must not trigger a second
  // request or a fresh operation ID.
  it.each([
    ['a server unavailable status', async (input: { operationId: string }) => status(input.operationId, 'unavailable')],
    ['a transport failure', async () => ({ kind: 'unavailable' }) as ChannelAccessResult],
    ['a thrown error', async () => { throw new Error('socket closed'); }],
  ])('makes exactly one request and keeps the operation ID on %s', async (_name, reply) => {
    const requestChannelAccess = vi.fn(reply as NonNullable<AgentClientPort['requestChannelAccess']>);
    const result = await cli(accessClient({ requestChannelAccess }), ['channels', 'request-access', URL_TARGET]);
    const operationId = defaultOperationId({ kind: 'channel_url', channelUrl: URL_TARGET });
    expect(requestChannelAccess).toHaveBeenCalledTimes(1);
    expect(result.code).toBe(4);
    expect(result.json()).toMatchObject({ operationId, next: 'reuse_operation_id' });
  });
});

describe('MCP channel access tools', () => {
  it('advertises strict schemas', async () => {
    const { tools } = await mcpCall(accessClient(), 'khala_channel_access_status', { operationId: 'op-1' });
    const request = tools.find(tool => tool.name === 'khala_request_channel_access');
    const readStatus = tools.find(tool => tool.name === 'khala_channel_access_status');
    expect(request?.inputSchema).toMatchObject({ required: ['target'], additionalProperties: false });
    expect(readStatus?.inputSchema).toMatchObject({ required: ['operationId'], additionalProperties: false });
  });

  it('returns the CLI projection as structured content', async () => {
    const client = accessClient();
    const viaCli = await cli(client, ['channels', 'request-access', URL_TARGET, '--operation', 'op-1']);
    const { result } = await mcpCall(client, 'khala_request_channel_access', { target: URL_TARGET, operationId: 'op-1' });
    expect(result.result.structuredContent).toEqual(viaCli.json());
    expect(JSON.parse(result.result.content[0].text)).toEqual(viaCli.json());
    expect(result.result.isError).toBeUndefined();
  });

  it('matches the CLI for status reads, including failures', async () => {
    const client = accessClient({ channelAccessStatus: async input => status(input.operationId, 'repair_required') });
    const viaCli = await cli(client, ['channels', 'access-status', '--operation', 'op-1']);
    const { result } = await mcpCall(client, 'khala_channel_access_status', { operationId: 'op-1' });
    expect(result.result.structuredContent).toEqual(viaCli.json());
  });

  it('derives the same default operation ID as the CLI and flags failures as errors', async () => {
    const requestChannelAccess = vi.fn<NonNullable<AgentClientPort['requestChannelAccess']>>(async () => ({ kind: 'unavailable' }));
    const { result } = await mcpCall(accessClient({ requestChannelAccess }), 'khala_request_channel_access', { target: 'ref-alpha' });
    expect(requestChannelAccess.mock.calls[0]?.[0].operationId).toBe(defaultOperationId({ kind: 'listing_ref', listingRef: 'ref-alpha' }));
    expect(requestChannelAccess).toHaveBeenCalledTimes(1);
    expect(result.result.isError).toBe(true);
    expect(result.result.structuredContent).toMatchObject({ ok: false, error: 'unavailable', next: 'reuse_operation_id' });
  });

  it.each([
    ['khala_request_channel_access', {}],
    ['khala_request_channel_access', { target: 'ref', extra: 1 }],
    ['khala_request_channel_access', { target: 'https://khala.aiur.team/channels/c?x=1' }],
    ['khala_request_channel_access', { target: 'ref', origin: 'http://khala.aiur.team' }],
    ['khala_channel_access_status', {}],
    ['khala_channel_access_status', { operationId: 'op-1', target: 'ref' }],
  ])('rejects %s %j as invalid params without calling the client', async (name, args) => {
    const requestChannelAccess = vi.fn(); const channelAccessStatus = vi.fn();
    const { result } = await mcpCall(accessClient({ requestChannelAccess, channelAccessStatus }), name, args);
    expect(result.error).toMatchObject({ code: -32602 });
    expect(requestChannelAccess).not.toHaveBeenCalled();
    expect(channelAccessStatus).not.toHaveBeenCalled();
  });
});

describe('parseAccessTarget', () => {
  it('splits URLs from listing references and refuses controls', () => {
    expect(parseAccessTarget('ref-alpha')).toEqual({ kind: 'listing_ref', listingRef: 'ref-alpha' });
    expect(parseAccessTarget(URL_TARGET)).toEqual({ kind: 'channel_url', channelUrl: URL_TARGET });
    expect(parseAccessTarget('http://127.0.0.1:8080/channels/c')).not.toBeNull();
    expect(parseAccessTarget('ref\u001b[2J')).toBeNull();
    expect(parseAccessTarget(`https://khala.aiur.team/${'a'.repeat(2100)}`)).toBeNull();
  });
});
