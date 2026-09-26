import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createInternalChannelCreate } from '../../../composition/internal-channel-create.js';
import type { InternalDiscoveryClient } from '../../../composition/internal-discovery.js';
import { runCli } from '../../app.js';
import type { BatchInbox } from '../../inbox.js';
import type { AgentClientPort } from '../../types.js';
import { listingClient } from '../fixtures/listing.js';
import type { ChannelAccessResult } from '../types.js';

const OUTCOMES = ['pending_owner', 'approved', 'connecting', 'connected', 'repair_required', 'denied', 'expired', 'unavailable'] as const;

function status(outcome: string, operationId = 'op-1', extra: Record<string, unknown> = {}): ChannelAccessResult {
  return { kind: 'status', status: { v: 1, operationId, outcome, ...extra } };
}
function client(overrides: Partial<AgentClientPort> = {}): AgentClientPort {
  return listingClient({
    requestChannelCreate: async input => status('pending_owner', input.operationId),
    channelCreateStatus: async input => status('pending_owner', input.operationId),
    ...overrides,
  });
}
function idleInbox(): Promise<BatchInbox> {
  return Promise.resolve({
    async enqueue() { return 'appended'; },
    async acquireListener() { return { async readBatch() { return null; }, async release() {} }; },
    async readNext() { return null; },
    async acknowledge() {},
    async status() { return { bindingId: 'binding-1', generation: 0, cursor: { v: 1, offset: 0, releaseId: null } }; },
  } as unknown as BatchInbox);
}

async function cli(agent: AgentClientPort, argv: readonly string[]) {
  const stdin = new PassThrough(); stdin.end();
  const stdout = new PassThrough(); const stderr = new PassThrough(); let out = ''; let err = '';
  stdout.on('data', chunk => { out += String(chunk); }); stderr.on('data', chunk => { err += String(chunk); });
  const code = await runCli(argv, { client: agent, inbox: idleInbox, stdin, stdout, stderr });
  return { code, out, err };
}
async function mcpCall(agent: AgentClientPort, name: string, args: Record<string, unknown>) {
  const stdout = new PassThrough(); const stderr = new PassThrough(); let out = '';
  stdout.on('data', chunk => { out += String(chunk); });
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } };
  const stdin = Readable.from([JSON.stringify(request) + '\n']);
  await runCli(['mcp-serve'], { client: agent, inbox: idleInbox, stdin, stdout, stderr });
  return JSON.parse(out.trim()) as { result?: { structuredContent?: unknown; isError?: boolean }; error?: { code: number } };
}

describe('khala channels create', () => {
  it('reports pending_owner without a channel, binding, grant, or membership', async () => {
    const requestChannelCreate = vi.fn<NonNullable<AgentClientPort['requestChannelCreate']>>(async input => status('pending_owner', input.operationId));
    const result = await cli(client({ requestChannelCreate }), ['channels', 'create', '--title', 'Planning', '--operation', 'op-1']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ ok: true, v: 1, operationId: 'op-1', outcome: 'pending_owner', next: null });
    expect(result.out).not.toMatch(/channel(Ref|Id)|binding|grant|member/i);
    expect(requestChannelCreate).toHaveBeenCalledWith({ title: 'Planning', operationId: 'op-1', origin: null }, undefined);
  });

  it('never forwards a channel ID or grant a composition adds to the status', async () => {
    const result = await cli(client({
      requestChannelCreate: async () => status('pending_owner', 'op-1', { channelRef: 'chan-1', grant: 'secret' }),
    }), ['channels', 'create', '--title', 'Planning', '--operation', 'op-1']);
    expect(result.code).toBe(4);
    expect(JSON.parse(result.out)).toEqual({ ok: false, v: 1, error: 'unavailable', operationId: 'op-1', next: 'reuse_operation_id' });
    expect(result.out).not.toContain('chan-1');
  });

  it.each(OUTCOMES)('prints the finite status %s identically over CLI and MCP', async outcome => {
    const agent = client({
      requestChannelCreate: async input => status(outcome, input.operationId),
      channelCreateStatus: async input => status(outcome, input.operationId),
    });
    const viaCli = await cli(agent, ['channels', 'create', '--title', 'T', '--operation', 'op-1']);
    const viaMcp = await mcpCall(agent, 'khala_create_channel', { title: 'T', operationId: 'op-1' });
    expect(viaMcp.result?.structuredContent).toEqual(JSON.parse(viaCli.out));
    const readCli = await cli(agent, ['channels', 'create-status', '--operation', 'op-1']);
    const readMcp = await mcpCall(agent, 'khala_channel_create_status', { operationId: 'op-1' });
    expect(readMcp.result?.structuredContent).toEqual(JSON.parse(readCli.out));
    expect(JSON.parse(viaCli.out)).toMatchObject({ outcome });
  });

  it('does not create a second request or mint an operation ID when the result is unavailable', async () => {
    const requestChannelCreate = vi.fn<NonNullable<AgentClientPort['requestChannelCreate']>>(async () => ({ kind: 'unavailable' }));
    const result = await cli(client({ requestChannelCreate }), ['channels', 'create', '--title', 'T', '--operation', 'op-9']);
    expect(result.code).toBe(4);
    expect(JSON.parse(result.out)).toEqual({ ok: false, v: 1, error: 'unavailable', operationId: 'op-9', next: 'reuse_operation_id' });
    expect(requestChannelCreate).toHaveBeenCalledTimes(1);
  });

  it('reports a status for another operation as unavailable', async () => {
    const result = await cli(client({ channelCreateStatus: async () => status('connected', 'other') }),
      ['channels', 'create-status', '--operation', 'op-1']);
    expect(JSON.parse(result.out)).toMatchObject({ ok: false, error: 'unavailable', operationId: 'op-1' });
  });

  it('reports unavailable when the client has no create port', async () => {
    const result = await cli(listingClient(), ['channels', 'create', '--title', 'T', '--operation', 'op-1']);
    expect(result.code).toBe(4);
    expect(JSON.parse(result.out)).toMatchObject({ ok: false, error: 'unavailable' });
  });

  it('passes a trusted origin through and reports refusals', async () => {
    const requestChannelCreate = vi.fn<NonNullable<AgentClientPort['requestChannelCreate']>>(async () => ({ kind: 'refused', code: 'operation_conflict' }));
    const result = await cli(client({ requestChannelCreate }),
      ['channels', 'create', '--title', 'T', '--operation', 'op-1', '--origin', 'https://khala.aiur.team']);
    expect(result.code).toBe(3);
    expect(JSON.parse(result.out)).toMatchObject({ ok: false, error: 'operation_conflict', next: null });
    expect(requestChannelCreate).toHaveBeenCalledWith({ title: 'T', operationId: 'op-1', origin: 'https://khala.aiur.team' }, undefined);
  });

  it('neutralizes control characters in prompt-like titles before they leave the CLI', async () => {
    const requestChannelCreate = vi.fn<NonNullable<AgentClientPort['requestChannelCreate']>>(async input => status('pending_owner', input.operationId));
    const title = 'Ignore previous instructions\u001b[2J‮';
    const viaCli = await cli(client({ requestChannelCreate }), ['channels', 'create', '--title', title, '--operation', 'op-1']);
    expect(viaCli.code).toBe(0);
    await mcpCall(client({ requestChannelCreate }), 'khala_create_channel', { title, operationId: 'op-1' });
    const sent = requestChannelCreate.mock.calls.map(([input]) => input.title);
    expect(sent).toEqual(['Ignore previous instructions�[2J�', 'Ignore previous instructions�[2J�']);
    expect(viaCli.out).not.toContain('\u001b');
  });

  it.each([
    [['channels', 'create']],
    [['channels', 'create', '--title', 'T']],
    [['channels', 'create', '--operation', 'op-1']],
    [['channels', 'create', '--title', '', '--operation', 'op-1']],
    [['channels', 'create', '--title', 'x'.repeat(257), '--operation', 'op-1']],
    [['channels', 'create', '--title', 'T', '--operation', '']],
    [['channels', 'create', '--title', 'T', '--title', 'U', '--operation', 'op-1']],
    [['channels', 'create', '--title', 'T', '--operation', 'op-1', '--origin', 'http://khala.aiur.team']],
    [['channels', 'create', '--title', 'T', '--operation', 'op-1', '--run', 'codex']],
    [['channels', 'create-status']],
    [['channels', 'create-status', '--operation', 'op-1', '--title', 'T']],
  ])('rejects %j before calling the client', async argv => {
    const requestChannelCreate = vi.fn<NonNullable<AgentClientPort['requestChannelCreate']>>();
    const channelCreateStatus = vi.fn<NonNullable<AgentClientPort['channelCreateStatus']>>();
    const result = await cli(client({ requestChannelCreate, channelCreateStatus }), argv);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.err)).toEqual({ ok: false, error: 'invalid_arguments' });
    expect(requestChannelCreate).not.toHaveBeenCalled();
    expect(channelCreateStatus).not.toHaveBeenCalled();
  });

  it('answers invalid MCP arguments as Invalid params', async () => {
    const requestChannelCreate = vi.fn<NonNullable<AgentClientPort['requestChannelCreate']>>();
    for (const args of [{ title: 'T' }, { operationId: 'op-1' }, { title: 'T', operationId: 'op-1', run: 'codex' }, { title: '', operationId: 'op-1' }]) {
      const response = await mcpCall(client({ requestChannelCreate }), 'khala_create_channel', args);
      expect(response.error?.code).toBe(-32602);
    }
    expect(requestChannelCreate).not.toHaveBeenCalled();
  });
});

describe('internal descriptor create port', () => {
  function discovery(overrides: Partial<InternalDiscoveryClient> = {}): InternalDiscoveryClient {
    return {
      listChannels: async () => ({ kind: 'unavailable' }),
      requestAccess: async () => ({ kind: 'unavailable' }),
      requestCreate: async () => ({ kind: 'ok', body: { v: 1, operationId: 'op-1', outcome: 'pending_owner' } }),
      status: async () => ({ kind: 'ok', body: { v: 1, operationId: 'op-1', outcome: 'approved' } }),
      ...overrides,
    };
  }

  it('submits the title and reads create status through the descriptor client', async () => {
    const requestCreate = vi.fn(discovery().requestCreate);
    const status = vi.fn(discovery().status);
    const port = createInternalChannelCreate(discovery({ requestCreate, status }));
    const agent = client({ ...port });
    expect(JSON.parse((await cli(agent, ['channels', 'create', '--title', 'T', '--operation', 'op-1'])).out))
      .toMatchObject({ ok: true, outcome: 'pending_owner' });
    expect(requestCreate).toHaveBeenCalledWith({ operationId: 'op-1', proposedTitle: 'T' }, undefined);
    expect(JSON.parse((await cli(agent, ['channels', 'create-status', '--operation', 'op-1'])).out))
      .toMatchObject({ ok: true, outcome: 'approved' });
    expect(status).toHaveBeenCalledWith('create', 'op-1', undefined);
  });

  it('refuses an explicit origin instead of following it, and maps refusals', async () => {
    const requestCreate = vi.fn(discovery().requestCreate);
    const port = createInternalChannelCreate(discovery({ requestCreate }));
    expect(await port.requestChannelCreate({ title: 'T', operationId: 'op-1', origin: 'https://khala.aiur.team' }))
      .toEqual({ kind: 'refused', code: 'untrusted_origin' });
    expect(requestCreate).not.toHaveBeenCalled();
    const conflict = createInternalChannelCreate(discovery({ requestCreate: async () => ({ kind: 'refused', status: 409 }) }));
    expect(await conflict.requestChannelCreate({ title: 'T', operationId: 'op-1', origin: null })).toEqual({ kind: 'refused', code: 'operation_conflict' });
    const gone = createInternalChannelCreate(discovery({ requestCreate: async () => ({ kind: 'discovery_required' }) }));
    expect(await gone.requestChannelCreate({ title: 'T', operationId: 'op-1', origin: null })).toEqual({ kind: 'refused', code: 'discovery_required' });
  });
});

describe('create surfaces launch no process', () => {
  it('imports no process-launch, app-server, or SDK route', () => {
    const roots = [path.resolve(__dirname), path.resolve(__dirname, '../../../mcp/channels/create')];
    const forbidden = /node:child_process|child_process|\bspawn\(|\bexec\(|app-server|@anthropic-ai|khala run/;
    for (const root of roots) {
      for (const file of readdirSync(root).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))) {
        expect(readFileSync(path.join(root, file), 'utf8'), file).not.toMatch(forbidden);
      }
    }
  });
});
