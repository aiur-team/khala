import { describe, expect, it, vi } from 'vitest';
import type { BootstrapPorts } from '@khala/connector/bootstrap/index';
import { bootstrapAgent } from '@khala/connector/bootstrap/index';
import type { AgentClientPort } from '../cli/types.js';
import { createConnectorBootstrapClient } from './bootstrap.js';

vi.mock('@khala/connector/bootstrap/index', () => ({ bootstrapAgent: vi.fn() }));

const mockedBootstrap = vi.mocked(bootstrapAgent);
const session = { harness: 'codex', sessionId: 'session-1', workdir: '/workspace' };
const send: AgentClientPort['send'] = async input => ({
  kind: 'accepted', clientTxnId: input.clientTxnId, eventId: 'event-1',
});
const status: AgentClientPort['status'] = async () => ({
  v: 1, connected: false, binding: null, route: 'unknown', sourceCursor: null,
});
const listChannels: AgentClientPort['listChannels'] = async () => ({ kind: 'unavailable' });
const listAgents: AgentClientPort['listAgents'] = async () => ({ kind: 'refused', code: 'not_joined' });

describe('connector bootstrap composition', () => {
  it('reuses a deterministic operation ID and maps blocked results', async () => {
    mockedBootstrap.mockResolvedValue({ kind: 'blocked', code: 'admission_denied' });
    const client = createConnectorBootstrapClient({
      ports: {} as BootstrapPorts, session, send, status, listChannels, listAgents,
    });

    await expect(client.connect('https://chat.example/i/room')).resolves.toEqual({
      kind: 'refused', code: 'admission_denied',
    });
    const first = mockedBootstrap.mock.calls[0]![0].operationId;
    expect(mockedBootstrap.mock.calls[0]![0]).toMatchObject({
      channelUrl: 'https://chat.example/i/room',
      operationId: 'yLnM_6ZpdiSG9ozWz11anaFcrTMfUVwV',
    });
    await client.connect('https://chat.example/i/room');
    expect(mockedBootstrap.mock.calls[1]![0].operationId).toBe(first);
  });

  it('maps unavailable and delegates send and status', async () => {
    mockedBootstrap.mockResolvedValue({ kind: 'unavailable', retryable: true, operationId: 'operation-1' });
    const delegatedSend = vi.fn(send);
    const delegatedStatus = vi.fn(status);
    const delegatedListChannels = vi.fn(listChannels);
    const delegatedListAgents = vi.fn(listAgents);
    const client = createConnectorBootstrapClient({
      ports: {} as BootstrapPorts, session, send: delegatedSend, status: delegatedStatus,
      listChannels: delegatedListChannels, listAgents: delegatedListAgents,
    });

    await expect(client.connect('https://chat.example/i/room')).resolves.toEqual({ kind: 'unavailable' });
    await client.send({ bindingId: null, clientTxnId: 'txn-12345678', body: 'hello' });
    await client.status();
    await client.listChannels({ origin: null, cursor: null });
    await client.listAgents({ bindingId: 'binding-1' as never });
    expect(delegatedSend).toHaveBeenCalledOnce();
    expect(delegatedStatus).toHaveBeenCalledOnce();
    expect(delegatedListChannels).toHaveBeenCalledOnce();
    expect(delegatedListAgents).toHaveBeenCalledOnce();
  });

  it('offers pairing only with configured pairing ports, with a stable per-code operation ID', async () => {
    const unconfigured = createConnectorBootstrapClient({ ports: {} as BootstrapPorts, session, send, status, listChannels, listAgents });
    expect(unconfigured.pair).toBeUndefined();

    const ports = { pairing: {}, discovery: { resolve: vi.fn(), resolvePairing: vi.fn() } } as unknown as BootstrapPorts;
    const client = createConnectorBootstrapClient({ ports, session, send, status, listChannels, listAgents });
    mockedBootstrap.mockReset();
    mockedBootstrap.mockResolvedValueOnce({ kind: 'pending', reason: 'approval_timeout', retryable: true, operationId: 'x' });
    await expect(client.pair!('7K3QX-9MZ2P')).resolves.toEqual({ kind: 'pending', reason: 'approval_timeout' });
    mockedBootstrap.mockResolvedValueOnce({ kind: 'blocked', code: 'pairing_denied' });
    const abort = new AbortController();
    await expect(client.pair!('7K3QX-9MZ2P', abort.signal)).resolves.toEqual({ kind: 'refused', code: 'pairing_denied' });
    mockedBootstrap.mockResolvedValueOnce({ kind: 'blocked', code: 'invalid_link' });
    await expect(client.pair!('7K3QX-9MZ2Q')).resolves.toEqual({ kind: 'unavailable' });

    const [first, second, third] = mockedBootstrap.mock.calls;
    expect(first![0]).toEqual({ pairingCode: '7K3QX-9MZ2P', session, operationId: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/) });
    expect(second![0].operationId).toBe(first![0].operationId);
    expect(second![2]).toEqual({ signal: abort.signal });
    expect(third![0].operationId).not.toBe(first![0].operationId);
    expect(first![0].operationId).not.toContain('7K3QX');
  });
});
