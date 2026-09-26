import { describe, expect, it, vi } from 'vitest';
import { decodeAuthPrincipal, decodeContentLimits, type RoomId } from '@khala/contracts/messaging/index';
import { createMemoryChannelJournal } from '@khala/messaging/channels/index';
import { closedAdmission, createLocalEvidencePort, createLocalPorts, readRequestSecret } from './ports';

const ORIGIN = 'http://127.0.0.1:4871';
const SECRET = 's'.repeat(43);
const CHANNEL = 'ch_1' as RoomId;
const limits = (() => {
  const decoded = decodeContentLimits({ maxBodyBytes: 16_384, maxDisplayNameBytes: 255, maxRoomTitleBytes: 255 });
  if (!decoded.ok) throw new Error('limits');
  return decoded.value;
})();
const human = { ownerId: 'owner_1', participantId: 'participant_h', deviceId: 'device_h' };
const view = { participantId: 'participant_h', kind: 'human', ownerId: 'owner_1', displayName: 'Owner', deviceIds: ['device_h'] };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function server(overrides: Partial<Record<string, () => Response>> = {}) {
  const requests: Array<{ method: string; path: string; secret: string | undefined; body: unknown }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({
      method: init?.method ?? 'GET', path: url.pathname, secret: headers['x-khala-request-secret'],
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    const override = overrides[key];
    if (override) return override();
    switch (key) {
      case 'GET /api/v1/session': return json(200, { human });
      case 'GET /api/v1/channels/ch_1': return json(200, { channel: { channelId: CHANNEL, title: null, membership: 'joined', revision: '1' }, participants: [view] });
      case 'POST /api/v1/channels/ch_1/messages': return json(201, {
        state: 'stored',
        event: {
          eventId: 'evt_1', channelId: CHANNEL, authorDeviceId: 'device_h', participant: view,
          content: (requests.at(-1)!.body as { content: unknown }).content, clientTxnId: 'txn_1', receivedAt: '2026-09-25T10:00:00.000Z',
        },
      });
      default: return json(404, { error: { code: 'not_found' } });
    }
  });
  return { fetch, requests };
}

describe('local ports', () => {
  it('reads the bootstrap request secret from session storage only', () => {
    expect(readRequestSecret({ getItem: key => (key === 'khala.requestSecret' ? SECRET : null) })).toBe(SECRET);
    expect(readRequestSecret({ getItem: () => { throw new Error('denied'); } })).toBeNull();
    expect(readRequestSecret(null)).toBeNull();
  });

  it('presents the bootstrapped session as an always-signed-in synthetic principal', async () => {
    const { fetch, requests } = server();
    const ports = createLocalPorts({ origin: ORIGIN, requestSecret: SECRET, limits, fetch, journal: createMemoryChannelJournal() });
    const state = await ports.identity.current();
    expect(state.kind).toBe('signed_in');
    if (state.kind !== 'signed_in') return;
    expect(decodeAuthPrincipal(state.principal).ok).toBe(true);
    expect(state.principal).toMatchObject({ ownerId: 'owner_1', sessionExpiresAt: '9999-12-31T23:59:59Z' });
    expect(Date.parse(state.principal.sessionExpiresAt)).toBeGreaterThan(Date.now());
    expect(requests).toEqual([{ method: 'GET', path: '/api/v1/session', secret: SECRET, body: undefined }]);
    await ports.identity.current();
    expect(requests).toHaveLength(1);
    expect(await ports.identity.beginSignIn('/')).toEqual({ kind: 'rejected', code: 'invalid_return_path' });
    expect(ports.participant()).toMatchObject({ participantId: 'participant_h', kind: 'human', ownerId: 'owner_1' });
  });

  it('maps a refused session to signed-out and an unreachable server to unavailable', async () => {
    const refused = createLocalPorts({
      origin: ORIGIN, requestSecret: SECRET, limits, fetch: server({ 'GET /api/v1/session': () => json(401, {}) }).fetch,
    });
    expect(await refused.identity.current()).toEqual({ kind: 'signed_out' });
    expect(refused.substrate.transport.current()).toEqual({ kind: 'auth_failed' });
    const lost = createLocalPorts({ origin: ORIGIN, requestSecret: SECRET, limits, fetch: vi.fn(async () => { throw new TypeError('offline'); }) });
    expect(await lost.identity.current()).toEqual({ kind: 'unavailable', retryable: true });
  });

  it('offers a fixed ready device only for the session owner', async () => {
    const ports = createLocalPorts({ origin: ORIGIN, requestSecret: SECRET, limits, fetch: server().fetch });
    expect(await ports.device.ensureReady('owner_1' as never)).toEqual({ kind: 'unavailable', retryable: true });
    expect(ports.device.current()).toMatchObject({ state: 'new', deviceId: null });
    await ports.identity.current();
    expect(await ports.device.ensureReady('owner_1' as never)).toEqual({
      kind: 'ok', value: { deviceId: 'device_h', state: 'ready', generation: 1, reason: null },
    });
    expect(await ports.device.ensureReady('owner_2' as never)).toEqual({ kind: 'rejected', code: 'owner_mismatch' });
  });

  it('keeps admission closed without contacting any server', async () => {
    expect(await closedAdmission.share({ operationId: 'op', roomId: CHANNEL, policy: { v: 1, kind: 'link', history: 'none' } })).toEqual({ kind: 'rejected', code: 'forbidden' });
    expect(await closedAdmission.inspect('invite')).toBe('unavailable');
    expect(await closedAdmission.admit({ operationId: 'op', inviteRef: 'invite' } as never)).toEqual({ kind: 'rejected', code: 'forbidden' });
  });

  it('sends through the journaled channel service over the loopback API', async () => {
    const { fetch, requests } = server();
    const ports = createLocalPorts({ origin: ORIGIN, requestSecret: SECRET, limits, fetch, journal: createMemoryChannelJournal() });
    expect(await ports.room.send({ roomId: CHANNEL, clientTxnId: 'txn_1', content: { v: 1, kind: 'text', body: 'hello' } }))
      .toEqual({ kind: 'unavailable', retryable: true });
    await ports.identity.current();
    const sent = await ports.room.send({ roomId: CHANNEL, clientTxnId: 'txn_1', content: { v: 1, kind: 'text', body: 'hello' } });
    expect(sent).toMatchObject({ kind: 'ok', value: { clientTxnId: 'txn_1', state: 'accepted', eventRef: { eventId: 'evt_1', authorDeviceId: 'device_h' } } });
    expect(requests.find(request => request.method === 'POST')).toMatchObject({
      path: '/api/v1/channels/ch_1/messages', secret: SECRET, body: { clientTxnId: 'txn_1', content: { v: 1, kind: 'text', body: 'hello' } },
    });
    ports.dispose();
  });
});

describe('local receipt evidence port', () => {
  it('decodes an owner read strictly and maps every refusal or failure to unavailable, never to an empty read', async () => {
    const signal = new AbortController().signal;
    const replies = [
      { kind: 'ok' as const, body: { v: 1, facts: [], groups: [] } },
      { kind: 'ok' as const, body: { v: 1, facts: {}, groups: [] } },
      { kind: 'rejected' as const, status: 403 },
      { kind: 'auth_failed' as const },
      { kind: 'unavailable' as const },
    ];
    const port = createLocalEvidencePort({ receiptEvidence: async () => replies.shift()! });
    expect(await port.read(CHANNEL, signal)).toEqual({ kind: 'ready', facts: [] });
    for (let index = 0; index < 4; index += 1) expect(await port.read(CHANNEL, signal)).toEqual({ kind: 'unavailable' });
  });
});
