import ready from '../../../contracts/fixtures/aiur-events/pr-ready-for-review.json';
import push from '../../../contracts/fixtures/aiur-events/system-branch-push.json';
import { Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { KhalaClientError, type KhalaAgentClient } from '../client';
import { createToolRegistry } from './registry';
import { runMcpServer } from './server';
import { createKhalaTools, errorCode } from './tools';

const link = 'https://127.0.0.1:8443/join/abc12345';
const confirmUrl = 'https://127.0.0.1:8443/agent/confirm?joinId=j_1';
const fake = (): KhalaAgentClient => ({
  join: vi.fn(async () => ({ state: 'awaiting_confirmation' as const, confirmUrl })),
  status: vi.fn(async () => ({ state: 'connected', channelName: 'Review', agentUserId: '@a:khala', unread: 17, listeningMode: 'sync' as const })),
  read: vi.fn(async () => ({ messages: [], nextBefore: '$next' })),
  send: vi.fn(async () => ({ eventId: '$sent' })),
  sendChannelEvent: vi.fn(async () => ({ eventId: '$event' })),
  close: vi.fn(async () => {}),
});
const call = (name: string, args: unknown = {}) => ({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args, _meta: { threadId: '019a-thread' } } });
async function exchange(messages: unknown[], client: KhalaAgentClient | null = fake(), harness: 'claude' | 'codex' = 'codex') {
  let text = '';
  const clientFor = vi.fn(() => client);
  await runMcpServer({
    input: Readable.from(messages.map(message => JSON.stringify(message) + '\n')),
    output: new Writable({ write(chunk, _encoding, done) { text += chunk.toString(); done(); } }),
    tools: createToolRegistry(createKhalaTools({ harness, clientFor })),
  });
  return { responses: text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), text, clientFor };
}

describe('five Khala tools through stdio', () => {
  it('advertises exactly five strict schemas in order', async () => {
    const { responses } = await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
    expect(responses[0].result.tools.map((tool: { name: string }) => tool.name)).toEqual(['khala_join', 'khala_status', 'khala_read', 'khala_send', 'khala_event']);
    expect(responses[0].result.tools.every((tool: { inputSchema: { additionalProperties: boolean } }) => tool.inputSchema.additionalProperties === false)).toBe(true);
  });
  it('returns confirmation instructions and forwards metadata and default label', async () => {
    const client = fake();
    const { responses, clientFor } = await exchange([call('khala_join', { link })], client);
    expect(client.join).toHaveBeenCalledWith(link, 'Codex');
    expect(clientFor).toHaveBeenCalledWith({ threadId: '019a-thread' });
    expect(responses[0]).toEqual({ jsonrpc: '2.0', id: 7, result: {
      content: [{ type: 'text', text: `Ask your human to open ${confirmUrl} and confirm. Then call khala_status until state is "connected".` }],
      structuredContent: { state: 'awaiting_confirmation', confirmUrl },
    } });
  });
  it('supports Claude, explicit labels and connected join text', async () => {
    const client = fake();
    client.join = vi.fn(async () => ({ state: 'connected' as const, channelName: 'Review' }));
    const { responses } = await exchange([call('khala_join', { link }), call('khala_join', { link, label: 'Reviewer' })], client, 'claude');
    expect(client.join).toHaveBeenNthCalledWith(1, link, 'Claude');
    expect(client.join).toHaveBeenNthCalledWith(2, link, 'Reviewer');
    expect(responses[0].result.content[0].text).toBe('Connected to Review.');
  });
  it.each([
    ['khala_join', { link, label: '' }], ['khala_join', { link, label: '   ' }],
    ['khala_join', { link, label: 'a'.repeat(41) }], ['khala_join', { link: 3 }],
    ['khala_join', { link, label: null }], ['khala_join', {}],
    ['khala_send', { text: '' }], ['khala_send', { text: 'a'.repeat(8001) }],
    ['khala_send', { text: 3 }], ['khala_send', {}],
    ['khala_read', { limit: 0 }], ['khala_read', { limit: 101 }], ['khala_read', { limit: 1.5 }],
    ['khala_read', { limit: '5' }], ['khala_read', { before: '' }], ['khala_read', { before: 3 }],
    ...['khala_join', 'khala_status', 'khala_read', 'khala_send'].map((name): [string, unknown] => [name, { x: 1 }]),
  ])('rejects malformed %s arguments before client lookup', async (name, args) => {
    const { responses, clientFor } = await exchange([call(name, args)]);
    expect(responses[0].error).toEqual({ code: -32602, message: 'Invalid params' });
    expect(clientFor).not.toHaveBeenCalled();
  });
  it('passes read options, status and successful send results unchanged', async () => {
    const client = fake();
    const { responses } = await exchange([call('khala_read'), call('khala_read', { limit: 5, before: '$e' }), call('khala_status'), call('khala_send', { text: 'a'.repeat(8000) })], client);
    expect(client.read).toHaveBeenNthCalledWith(1, 30, undefined);
    expect(client.read).toHaveBeenNthCalledWith(2, 5, '$e');
    expect(client.send).toHaveBeenCalledTimes(1);
    expect(responses.map(response => response.result.structuredContent)).toEqual([
      { messages: [], nextBefore: '$next' }, { messages: [], nextBefore: '$next' },
      { state: 'connected', channelName: 'Review', agentUserId: '@a:khala', unread: 17, listeningMode: 'sync' as const }, { eventId: '$sent' },
    ]);
    for (const response of responses) expect(response.result.content[0].text).toBe(JSON.stringify(response.result.structuredContent));
  });
  it.each(['invalid_link', 'link_unavailable', 'join_expired'] as const)('preserves client join error %s', async code => {
    const client = fake();
    client.join = vi.fn(async () => { throw new KhalaClientError(code, 'token=abc'); });
    const { responses, text } = await exchange([call('khala_join', { link: 'https://example.com' })], client);
    expect(responses[0].result).toMatchObject({ isError: true, structuredContent: { error: code } });
    expect(text).not.toContain('abc');
  });
  it('preserves not_connected and suppresses unknown error details', async () => {
    const client = fake();
    client.send = vi.fn(async () => { throw new KhalaClientError('not_connected'); });
    client.status = vi.fn(async () => { throw new Error('token=abc'); });
    const { responses, text } = await exchange([call('khala_send', { text: 'hello' }), call('khala_status')], client);
    expect(responses.map(response => response.result.structuredContent)).toEqual([{ error: 'not_connected' }, { error: 'internal_error' }]);
    expect(text).not.toContain('abc');
  });
  it.each(['khala_join', 'khala_status', 'khala_read', 'khala_send'])('returns session_unknown for %s without a client', async name => {
    const args = name === 'khala_join' ? { link } : name === 'khala_send' ? { text: 'hello' } : {};
    const { responses } = await exchange([call(name, args)], null);
    expect(responses[0].result).toMatchObject({ isError: true, structuredContent: { error: 'session_unknown' } });
  });
  it('only exposes allowlisted error codes', () => {
    expect(errorCode({ code: 'send_failed' })).toBe('send_failed');
    for (const error of [null, 'send_failed', { code: 1 }, { code: 'token=abc' }]) expect(errorCode(error)).toBe('internal_error');
  });
});

describe('channel event tool through stdio', () => {
  const event = { kind: 'ci.passed', summary: 'CI passed' };
  it('sends canonical native content and renders the posted line', async () => {
    const client = fake();
    const { responses } = await exchange([call('khala_event', { event })], client);
    expect(client.sendChannelEvent).toHaveBeenCalledExactlyOnceWith({ ...event, v: 1, body: 'CI passed' });
    expect(responses[0].result).toEqual({ content: [{ type: 'text', text: 'Posted channel event: CI passed' }], structuredContent: { eventId: '$event' } });
    expect(client.send).not.toHaveBeenCalled();
  });
  it.each([
    [{ event: { ...event, url: 'javascript:alert(1)' } }, 'url'],
    [{ event, aiur: ready }, ''], [{}, ''], [{ event: [] }, 'event'],
    [{ aiur: ready, ticketPrefix: 1 }, 'ticketPrefix'], [{ event, extra: true }, 'extra'],
  ])('returns invalid_event with a location and never looks up a client', async (args, path) => {
    const client = fake();
    const { responses, clientFor } = await exchange([call('khala_event', args)], client);
    expect(responses[0].result).toMatchObject({ isError: true, structuredContent: { error: 'invalid_event', path, code: 'invalid_value' } });
    expect(clientFor).not.toHaveBeenCalled();
    expect(client.sendChannelEvent).not.toHaveBeenCalled();
  });
  it('skips system records without a session and sends the prefixed review fixture', async () => {
    const client = fake();
    const skipped = await exchange([call('khala_event', { aiur: push })], null);
    expect(skipped.responses[0].result.structuredContent).toEqual({ skipped: true });
    expect(skipped.clientFor).not.toHaveBeenCalled();
    const { responses } = await exchange([call('khala_event', { aiur: ready, ticketPrefix: 'AIUR-' })], client);
    expect(client.sendChannelEvent).toHaveBeenCalledOnce();
    expect(client.sendChannelEvent).toHaveBeenCalledWith(expect.objectContaining({ body: 'AIUR-395 review requested · feat/events-cursor' }));
    expect(responses[0].result.content[0].text).toBe('Posted channel event: AIUR-395 review requested · feat/events-cursor');
  });
  it.each(['not_connected', 'send_failed'] as const)('preserves %s event-send errors', async code => {
    const client = fake();
    client.sendChannelEvent = vi.fn(async () => { throw new KhalaClientError(code, 'SECRET'); });
    const { responses, text } = await exchange([call('khala_event', { event })], client);
    expect(responses[0].result).toMatchObject({ isError: true, structuredContent: { error: code } });
    expect(text).not.toContain('SECRET');
  });
  it('returns session_unknown for a send without a client', async () => {
    const { responses } = await exchange([call('khala_event', { event })], null);
    expect(responses[0].result).toMatchObject({ isError: true, structuredContent: { error: 'session_unknown' } });
  });
  it('advertises the exclusive object inputs and bounded optional prefix', async () => {
    const { responses } = await exchange([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
    expect(responses[0].result.tools[4].inputSchema).toEqual({
      type: 'object', properties: { event: { type: 'object' }, aiur: { type: 'object' }, ticketPrefix: { type: 'string', minLength: 0, maxLength: 16 } },
      required: [], additionalProperties: false,
      oneOf: [{ required: ['event'], not: { required: ['aiur'] } }, { required: ['aiur'], not: { required: ['event'] } }],
    });
  });
});

it('renders an auto-confirmed fallback without a confirmation click', async () => {
  const client = fake();
  const result = { state: 'awaiting_confirmation' as const, confirmUrl, autoConfirmed: true as const };
  client.join = vi.fn(async () => result);
  const { responses } = await exchange([call('khala_join', { link })], client);
  expect(responses[0].result).toEqual({
    content: [{ type: 'text', text: 'Joining… call khala_status until state is "connected".' }],
    structuredContent: result,
  });
});
