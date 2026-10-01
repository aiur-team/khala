import { describe, expect, it, vi } from 'vitest';
import { CLOSURE_CONSEQUENCES, decodeContentLimits, type ChannelAccessRequestHandle, type DeviceId, type OwnerId, type RoomId } from '@khala/contracts/messaging/index';
import { createHumanBrowserApi } from './browser-api';
import { createBrowserDeviceService } from '@khala/messaging/browser-device/index';

const origin = 'https://khala.aiur.team';
const homeserverOrigin = 'https://matrix.example.test';
const decodedLimits = decodeContentLimits({ maxBodyBytes: 4_096, maxDisplayNameBytes: 128, maxRoomTitleBytes: 256 });
if (!decodedLimits.ok) throw new Error('invalid test limits');
const limits = decodedLimits.value;
const principal = {
  v: 1 as const,
  ownerId: 'owner_alice' as OwnerId,
  providerIssuer: 'https://issuer.example',
  providerSubject: 'alice',
  verifiedEmail: 'alice@example.test',
  sessionExpiresAt: '2030-01-01T00:00:00Z',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('createHumanBrowserApi', () => {
  it('recognizes a completed send transaction from the room fence', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(200, { principal, csrfToken: 'csrf-proof' }))
      .mockResolvedValueOnce(json(200, { kind: 'complete', eventId: '$sent:example' }));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch });
    expect(await api.roomSend.acquire({ roomId: '!room:example' as RoomId,
      deviceId: 'DEVICE', matrixAccessToken: 'matrix-token' }, 'txn_completed'))
      .toEqual({ kind: 'complete', eventId: '$sent:example' });
  });
  it('decodes personal issuance and human resolution with the current CSRF proof', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(200, { principal, csrfToken: 'csrf-proof' }))
      .mockResolvedValueOnce(json(200, { v: 1, kind: 'personal_link', shareUrl: `${origin}/join/invite_alice123`, expiresAt: null }))
      .mockResolvedValueOnce(json(200, { v: 1, kind: 'join_required' }));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch });
    expect(await api.channelLinks.personal('room_1' as RoomId)).toEqual({ v: 1, kind: 'personal_link',
      shareUrl: `${origin}/join/invite_alice123`, expiresAt: null });
    expect(await api.channelLinks.resolve(`${origin}/join/invite_alice123`)).toEqual({ v: 1, kind: 'join_required' });
    expect(fetch.mock.calls.slice(1).map(call => call[0])).toEqual([
      `${origin}/api/human/channel-link/personal`, `${origin}/api/human/channel-link/resolve`,
    ]);
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get('x-khala-csrf')).toBe('csrf-proof');
  });

  it('refuses a personal link on another origin', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(200, { principal, csrfToken: 'csrf-proof' }))
      .mockResolvedValueOnce(json(200, { v: 1, kind: 'personal_link',
        shareUrl: 'https://other.example/join/invite_alice123', expiresAt: null }));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch });
    expect(await api.channelLinks.personal('room_1' as RoomId)).toEqual({ v: 1, kind: 'unavailable' });
  });

  it('retrieves exact owner cleanup requests without needing the closed room in its view', async () => {
    const command = { operationId: 'close_1', ownerId: principal.ownerId, roomId: 'room_1' as RoomId, expectedRoomRevision: 0 };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(200, { kind: 'ok', value: [command] }))
      .mockResolvedValueOnce(json(200, { kind: 'ok', value: [{ ...command, ownerId: 'peer_owner' }] }));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch });
    expect(await api.cleanupRequests(principal.ownerId)).toEqual([command]);
    expect(fetch.mock.calls[0]?.[0]).toBe(`${origin}/api/human/channel-closure?cleanup=1`);
    expect(fetch.mock.calls[0]?.[1]?.credentials).toBe('same-origin');
    expect(await api.cleanupRequests(principal.ownerId)).toBeNull();
  });

  it('reads a room-scoped closure capability and posts with the human CSRF proof', async () => {
    const roomId = 'room_1' as RoomId;
    const capability = { ownerId: principal.ownerId, roomId, expectedRoomRevision: 0,
      available: true, unavailableReason: null, consequences: CLOSURE_CONSEQUENCES };
    const state = { operationId: 'close_1', state: 'partial', reason: 'local_cleanup_failed' };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(200, { kind: 'ok', value: capability }))
      .mockResolvedValueOnce(json(200, { principal, csrfToken: 'csrf-proof' }))
      .mockResolvedValueOnce(json(200, { kind: 'ok', value: state }))
      .mockResolvedValueOnce(json(200, { kind: 'ok', value: state }));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch });
    const closure = api.closure(roomId);
    expect(await closure.currentCapability()).toEqual(capability);
    const command = { operationId: 'close_1', ownerId: principal.ownerId, roomId, expectedRoomRevision: 0 };
    expect(await closure.closeRoom(command)).toEqual({ kind: 'ok', value: state });
    expect(await closure.inspectClosure('close_1')).toEqual({ kind: 'ok', value: state });
    expect(fetch.mock.calls[0]?.[0]).toContain('roomId=room_1');
    expect(fetch.mock.calls[2]?.[0]).toBe(`${origin}/api/human/channel-closure`);
    expect(new Headers(fetch.mock.calls[2]?.[1]?.headers).get('x-khala-csrf')).toBe('csrf-proof');
    expect(await closure.closeRoom({ ...command, roomId: 'room_2' as RoomId })).toEqual({ kind: 'rejected', code: 'forbidden' });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('projects the current verified principal and uses its CSRF proof for admission writes', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(200, { principal, csrfToken: 'csrf-proof' }))
      .mockResolvedValueOnce(json(200, {
        kind: 'ok',
        value: { inviteRef: 'invite_1', shareUrl: `${origin}/join?invite=invite_1`, expiresAt: null },
      }));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch });

    expect(await api.identity.current()).toEqual({ kind: 'signed_in', principal });
    expect(await api.admission.share({
      operationId: 'share_1',
      roomId: 'room_1' as RoomId,
      policy: { v: 1, kind: 'link', history: 'full' },
    })).toMatchObject({
      kind: 'ok', value: { inviteRef: 'invite_1' },
    });

    const request = fetch.mock.calls[1]!;
    expect(request[0]).toBe(`${origin}/api/human/invitations/share`);
    expect(new Headers(request[1]?.headers).get('x-khala-csrf')).toBe('csrf-proof');
    expect(request[1]?.credentials).toBe('same-origin');
    expect(request[1]?.body).toBe(JSON.stringify({
      operationId: 'share_1',
      roomId: 'room_1',
      policy: { v: 1, kind: 'link', history: 'full' },
    }));
  });

  it('keeps signed out and unavailable identity states distinct', async () => {
    const signedOut = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch: vi.fn(async () => json(401, { code: 'authentication_required' })) });
    expect(await signedOut.identity.current()).toEqual({ kind: 'signed_out' });

    const malformed = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch: vi.fn(async () => json(200, { principal: { ownerId: 'bad' } })) });
    expect(await malformed.identity.current()).toEqual({ kind: 'unavailable', retryable: true });
  });

  it('bounds every control request with a finite timeout', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch, timeoutMs: 5 });

    expect(await api.identity.current()).toEqual({ kind: 'unavailable', retryable: true });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('builds only same-origin sign-in navigation', async () => {
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch: vi.fn() });
    expect(await api.identity.beginSignIn('/join?invite=invite_1')).toEqual({
      kind: 'ok', value: { kind: 'navigate', url: `${origin}/api/human/auth/login?return_to=%2Fjoin%3Finvite%3Dinvite_1` },
    });
    expect(await api.identity.beginSignIn('//evil.example')).toEqual({ kind: 'rejected', code: 'invalid_return_path' });
  });

  it('preserves an ambiguous logout operation identity', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(200, { principal, csrfToken: 'csrf-proof' }))
      .mockResolvedValueOnce(json(502, { code: 'outcome_unknown', operationId: 'logout_1' }));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch });

    expect(await api.identity.current()).toEqual({ kind: 'signed_in', principal });
    expect(await api.identity.signOut('logout_1')).toEqual({ kind: 'outcome_unknown', operationId: 'logout_1' });
  });

  it('decodes inspection and admission without accepting invented success', async () => {
    const room = { roomId: 'room_1', title: null, membership: 'joined', revision: '1' };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(200, { principal, csrfToken: 'csrf-proof' }))
      .mockResolvedValueOnce(json(200, { state: 'eligible' }))
      .mockResolvedValueOnce(json(200, { kind: 'ok', value: { outcome: 'joined', room } }))
      .mockResolvedValueOnce(json(200, { kind: 'ok', value: { outcome: 'joined', room: { ...room, membership: 'left' } } }));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch });

    expect(await api.identity.current()).toEqual({ kind: 'signed_in', principal });
    expect(await api.admission.inspect('invite_1')).toBe('eligible');
    expect(await api.admission.admit({ operationId: 'admit_1', inviteRef: 'invite_1', deviceId: 'device_1' as DeviceId })).toMatchObject({
      kind: 'ok', value: { outcome: 'joined' },
    });
    expect(await api.admission.admit({ operationId: 'admit_2', inviteRef: 'invite_1', deviceId: 'device_1' as DeviceId })).toEqual({
      kind: 'unavailable', retryable: true,
    });
  });

  it('mints Matrix credentials for one stable browser device without exposing a password', async () => {
    const deviceIds = { get: vi.fn(() => 'KH_WEB_1'), put: vi.fn() };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(200, { principal, csrfToken: 'csrf-proof' }))
      .mockResolvedValueOnce(json(200, {
        session: {
          homeserverOrigin: 'https://matrix.example.test',
          userId: '@alice:matrix.example.test',
          accessToken: 'device-token',
          deviceId: 'KH_WEB_1',
          publishedFingerprint: 'ed25519-key',
        },
      }));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch, deviceIds,
      existingDevice: async () => ({ markerDeviceId: 'KH_WEB_1', hasDivergentCryptoStore: false }) });

    expect(await api.credentials.resolve(principal, new AbortController().signal)).toEqual({
      kind: 'ok',
      session: {
        deviceId: 'KH_WEB_1',
        publishedFingerprint: 'ed25519-key',
        credentials: {
          homeserverOrigin: 'https://matrix.example.test',
          userId: '@alice:matrix.example.test',
          accessToken: 'device-token',
        },
      },
    });
    expect(fetch.mock.calls[1]?.[0]).toBe(`${origin}/api/human/messaging/session`);
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ deviceId: 'KH_WEB_1' }));
    expect(JSON.stringify(fetch.mock.calls)).not.toContain('password');
  });

  it.each([
    { stored: null, markerDeviceId: 'KH_WEB_OLD', hasDivergentCryptoStore: true },
    { stored: 'KH_WEB_NEW', markerDeviceId: 'KH_WEB_OLD', hasDivergentCryptoStore: true },
    { stored: null, markerDeviceId: null, hasDivergentCryptoStore: true },
  ])('refuses to mint or request a session when device authority diverges: %j', async existing => {
    const deviceIds = { get: vi.fn(() => existing.stored), put: vi.fn() };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(200, { principal, csrfToken: 'csrf-proof' }));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch, deviceIds,
      existingDevice: async () => existing });
    expect(await api.credentials.resolve(principal, new AbortController().signal))
      .toEqual({ kind: 'unavailable', reason: 'recovery_required' });
    expect(deviceIds.put).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('mints a new device only when the profile has no owner marker or crypto store', async () => {
    const deviceIds = { get: vi.fn(() => null), put: vi.fn() };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(200, { principal, csrfToken: 'csrf-proof' }))
      .mockImplementationOnce(async (_url, init) => json(200, { session: {
        homeserverOrigin, userId: '@alice:matrix.example.test', accessToken: 'fresh-token',
        deviceId: JSON.parse(String(init?.body)).deviceId, publishedFingerprint: null,
      } }));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch, deviceIds,
      existingDevice: async () => ({ markerDeviceId: null, hasDivergentCryptoStore: false }) });
    const result = await api.credentials.resolve(principal, new AbortController().signal);
    expect(result.kind).toBe('ok');
    expect(deviceIds.put).toHaveBeenCalledOnce();
    expect(deviceIds.put.mock.calls[0]?.[1]).toMatch(/^KH_WEB_/);
  });

  it('permits a new device with explicit replacement admission while preserving old storage', async () => {
    const deviceIds = { get: vi.fn(() => null), put: vi.fn() };
    const authorizeReplacement = vi.fn(async () => true);
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(200, { principal, csrfToken: 'csrf-proof' }))
      .mockImplementationOnce(async (_url, init) => json(200, { session: {
        homeserverOrigin, userId: '@alice:matrix.example.test', accessToken: 'replacement-token',
        deviceId: JSON.parse(String(init?.body)).deviceId, publishedFingerprint: null,
      } }));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch, deviceIds,
      existingDevice: async () => ({ markerDeviceId: 'KH_WEB_OLD', hasDivergentCryptoStore: true }),
      authorizeReplacement });
    const result = await api.credentials.resolve(principal, new AbortController().signal);
    expect(result).toMatchObject({ kind: 'ok', session: { publishedFingerprint: null } });
    const newDeviceId = deviceIds.put.mock.calls[0]?.[1];
    expect(newDeviceId).toMatch(/^KH_WEB_/);
    expect(newDeviceId).not.toBe('KH_WEB_OLD');
    expect(authorizeReplacement).toHaveBeenCalledWith(principal, newDeviceId);
  });

  it('continues from accepted loss to an admitted new device without opening the old store', async () => {
    let localDeviceId: string | null = 'KH_WEB_OLD';
    let admitted = false;
    const markers = new Map<string, { deviceId: DeviceId; fingerprint: string }>([
      [principal.ownerId, { deviceId: 'KH_WEB_OLD' as DeviceId, fingerprint: 'old-fingerprint' }],
    ]);
    const opened: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (String(input).endsWith('/api/human/me')) return json(200, { principal, csrfToken: 'csrf-proof' });
      const deviceId = JSON.parse(String(init?.body)).deviceId as string;
      return json(200, { session: { homeserverOrigin, userId: '@alice:matrix.example.test',
        accessToken: 'token', deviceId,
        publishedFingerprint: deviceId === 'KH_WEB_OLD' ? 'old-fingerprint' : null } });
    });
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch,
      deviceIds: { get: () => localDeviceId, put: (_owner, value) => { localDeviceId = value; } },
      existingDevice: async () => ({ markerDeviceId: markers.get(principal.ownerId)?.deviceId ?? null,
        hasDivergentCryptoStore: localDeviceId !== 'KH_WEB_OLD' }),
      authorizeReplacement: async () => admitted });
    const service = createBrowserDeviceService({
      identity: api.identity, credentials: api.credentials,
      markers: { get: async ownerId => markers.get(ownerId) ?? null,
        put: async (ownerId, marker) => { markers.set(ownerId, marker); },
        clear: async ownerId => { markers.delete(ownerId); } },
      stores: { open: async (_owner, deviceId) => {
        opened.push(deviceId);
        return { name: deviceId, close: async () => undefined };
      } },
      engines: { open: async ({ session }) => ({
        identity: async () => ({ fingerprint: session.deviceId === 'KH_WEB_OLD' ? 'wrong-keys' : 'new-fingerprint',
          created: opened.filter(deviceId => deviceId === session.deviceId).length === 1 }),
        start: async () => undefined, close: async () => undefined,
      }) },
      locks: { acquire: async () => ({ kind: 'acquired', lease: { release: () => undefined } }) },
    });

    expect(await service.ensureReady(principal.ownerId)).toMatchObject({ kind: 'ok', value: { state: 'lost' } });
    expect(await service.acceptLoss(principal.ownerId)).toMatchObject({ kind: 'ok', value: { state: 'new' } });
    localDeviceId = null;
    expect(await service.ensureReady(principal.ownerId)).toMatchObject({ kind: 'unavailable' });
    expect(opened).toEqual(['KH_WEB_OLD']);
    admitted = true; // The injected authority represents #486's verified admission boundary.
    expect(await service.ensureReady(principal.ownerId)).toMatchObject({ kind: 'ok', value: { state: 'ready' } });
    expect(opened).toHaveLength(2);
    expect(opened[1]).not.toBe('KH_WEB_OLD');
    expect(markers.get(principal.ownerId)?.deviceId).toBe(opened[1]);
    admitted = false;
    await service.stop();
    expect(await service.ensureReady(principal.ownerId)).toMatchObject({ kind: 'ok', value: { state: 'ready' } });
  });

  it('fails closed when owner storage cannot be inspected', async () => {
    const deviceIds = { get: vi.fn(() => null), put: vi.fn() };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(200, { principal, csrfToken: 'csrf-proof' }));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch, deviceIds,
      existingDevice: async () => { throw new Error('database listing unavailable'); } });
    expect(await api.credentials.resolve(principal, new AbortController().signal)).toEqual({ kind: 'unavailable' });
    expect(deviceIds.put).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('accepts a returned loopback Matrix session only in explicit local mode', async () => {
    const localOrigin = 'http://localhost:8888';
    const localMatrix = 'http://127.0.0.1:8008';
    const session = { homeserverOrigin: localMatrix, userId: '@alice:localhost', accessToken: 'device-token',
      deviceId: 'KH_WEB_1', publishedFingerprint: null };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(200, { principal, csrfToken: 'csrf-proof' }))
      .mockResolvedValueOnce(json(200, { session }));
    const api = createHumanBrowserApi({ origin: localOrigin, homeserverOrigin: localMatrix,
      allowInsecureLoopback: true, limits, fetch, deviceIds: { get: () => 'KH_WEB_1', put: () => {} },
      existingDevice: async () => ({ markerDeviceId: null, hasDivergentCryptoStore: false }) });
    expect(await api.credentials.resolve(principal, new AbortController().signal)).toMatchObject({
      kind: 'ok', session: { credentials: { homeserverOrigin: localMatrix } },
    });
  });

  it('decodes server-authoritative Matrix participant mappings', async () => {
    const userId = '@khala_b3duZXJfYm9i:matrix.example.test';
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(200, { principal, csrfToken: 'csrf-proof' }))
      .mockResolvedValueOnce(json(200, {
        participants: [{
          matrixUserId: userId,
          participantId: 'human_1234',
          ownerId: 'owner_bob',
          displayName: userId,
        }],
      }));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch });

    const participants = await api.participants.resolve([userId]);
    expect(participants?.get(userId)).toEqual({
      participantId: 'human_1234',
      kind: 'human',
      ownerId: 'owner_bob',
      displayName: userId,
      deviceIds: [],
    });
  });

  it('resolves agent identity inside an authenticated room scope', async () => {
    const userId = '@khala_a_test:matrix.example.test';
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(200, { principal, csrfToken: 'csrf-proof' }))
      .mockResolvedValueOnce(json(200, { participants: [{ matrixUserId: userId,
        participantId: 'agent_420', ownerId: 'owner_bob', displayName: 'Codex #420', kind: 'agent' }] }));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch });
    const participants = await api.participants.resolve([userId], undefined, 'room_1' as RoomId);
    expect(participants?.get(userId)).toMatchObject({ kind: 'agent', participantId: 'agent_420', ownerId: 'owner_bob' });
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ userIds: [userId], roomId: 'room_1' }));
  });

  it('resolves a departed rename target by participant ID within the authorized room', async () => {
    const userId = '@owner:matrix.example.test';
    const targetId = 'agent_departed' as never;
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(200, { principal, csrfToken: 'csrf-proof' }))
      .mockResolvedValueOnce(json(200, { participants: [
        { matrixUserId: userId, participantId: 'human_owner', ownerId: 'owner_bob', displayName: 'Maya', kind: 'human' },
        { matrixUserId: '@departed:matrix.example.test', participantId: targetId, ownerId: 'owner_bob', displayName: 'Codex #420', kind: 'agent' },
      ] }));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch });
    const resolved = await api.participants.resolve([userId], undefined, 'room_1' as RoomId, [targetId]);
    expect(resolved?.get('@departed:matrix.example.test')).toMatchObject({ participantId: targetId, kind: 'agent' });
    expect(JSON.parse(String(fetch.mock.calls[1]![1]!.body))).toEqual({ userIds: [userId], roomId: 'room_1', targetParticipantIds: [targetId] });
  });

  it('distinguishes an omitted target in a successful response from lookup failure', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(200, { principal, csrfToken: 'csrf-proof' }))
      .mockResolvedValueOnce(json(200, { participants: [] }))
      .mockResolvedValueOnce(json(503, {}));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch });
    expect(await api.participants.resolve([], undefined, 'room_1' as RoomId, ['agent_unknown' as never])).toEqual(new Map());
    expect(await api.participants.resolve([], undefined, 'room_1' as RoomId, ['agent_unknown' as never])).toBeNull();
  });

  it('binds the channel-request inbox and decisions to human-cookie routes', async () => {
    const requestHandle = 'careq_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq' as ChannelAccessRequestHandle;
    const projection = {
      v: 1, requestHandle, operationKind: 'access', outcome: 'pending_owner', revision: 'carev_1',
      requester: { sessionFingerprint: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq', harness: 'codex', displayLabel: null, workspaceLabel: null },
      detail: { kind: 'access', title: 'Plans', history: 'none' }, createdAt: '2026-09-25T00:00:00.000Z',
      deadline: '2026-10-02T00:00:00.000Z', ownerDecision: 'pending', decidedAt: null, muted: false, muteRevision: null,
    };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(200, { v: 1, kind: 'ok', requests: [projection] }))
      .mockResolvedValueOnce(json(200, { principal, csrfToken: 'csrf-proof' }))
      .mockResolvedValueOnce(json(200, { ...projection, outcome: 'approved', ownerDecision: 'approved' }))
      .mockResolvedValueOnce(json(200, { v: 1, operationKind: 'access', muted: true, revision: 'carev_2' }));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch });

    expect(await api.channelAccess.inbox()).toEqual({ kind: 'ok', value: [projection] });
    expect(await api.channelAccess.decide({
      v: 1, requestHandle, expectedRevision: 'carev_1', decision: 'approve', operationId: 'decide_1',
    })).toMatchObject({ kind: 'ok', value: { ownerDecision: 'approved' } });
    expect(await api.channelAccess.setMute({
      v: 1, requestHandle, expectedRevision: null, action: 'mute', operationId: 'mute_1',
    })).toEqual({ kind: 'ok', value: { v: 1, operationKind: 'access', muted: true, revision: 'carev_2' } });

    expect(fetch.mock.calls[0]?.[0]).toBe(`${origin}/api/human/channel-access/inbox`);
    expect(fetch.mock.calls[2]?.[0]).toBe(`${origin}/api/human/channel-access/decision`);
    expect(fetch.mock.calls[3]?.[0]).toBe(`${origin}/api/human/channel-access/mute`);
    expect(new Headers(fetch.mock.calls[2]?.[1]?.headers).get('x-khala-csrf')).toBe('csrf-proof');
  });

  it('distinguishes inbox authority loss from retryable route failures', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(401, { code: 'signed_out' }))
      .mockResolvedValueOnce(json(403, { code: 'forbidden' }))
      .mockResolvedValueOnce(json(404, { code: 'not_found' }))
      .mockResolvedValueOnce(json(200, { v: 1, kind: 'ok', requests: 'malformed' }));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch });

    expect(await api.channelAccess.inbox()).toEqual({ kind: 'rejected', code: 'forbidden' });
    expect(await api.channelAccess.inbox()).toEqual({ kind: 'rejected', code: 'forbidden' });
    expect(await api.channelAccess.inbox()).toEqual({ kind: 'unavailable', retryable: true });
    expect(await api.channelAccess.inbox()).toEqual({ kind: 'unavailable', retryable: true });
  });
});
