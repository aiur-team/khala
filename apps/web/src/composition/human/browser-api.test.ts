import { describe, expect, it, vi } from 'vitest';
import { decodeContentLimits, type DeviceId, type OwnerId, type RoomId } from '@khala/contracts/messaging/index';
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
  it('exposes only the human admission and messaging adapters', () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch });
    expect(Object.keys(api).sort()).toEqual(['admission', 'agentJoin', 'agentNames', 'channelLinks', 'credentials', 'identity', 'participants', 'profile']);
    expect(fetch).not.toHaveBeenCalled();
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

  it.each([false, true])('resolves C3 unknown members without losing known identities (unknown only: %s)', async unknownOnly => {
    const entries = [
      { matrixUserId: '@maya:hs', participantId: 'human_maya', ownerId: 'owner_maya', displayName: 'Maya', kind: 'human' },
      { matrixUserId: '@bot:hs', participantId: 'agent_bot', ownerId: 'owner_kevin', displayName: 'Claude · Kevin', kind: 'agent', ownerLabel: 'Kevin', harness: 'claude' },
      { matrixUserId: '@stranger:hs', displayName: '@stranger:hs', kind: 'unknown' },
    ].slice(unknownOnly ? 2 : 0);
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(200, { principal, csrfToken: 'csrf-proof' }))
      .mockResolvedValueOnce(json(200, { participants: entries }));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch });
    await api.identity.current({ signal: new AbortController().signal });
    fetch.mockClear();
    const userIds = entries.map(entry => entry.matrixUserId);
    const result = await api.participants.resolve(userIds, undefined, 'room_1' as RoomId, undefined,
      { deviceId: 'WEB_DEVICE', matrixAccessToken: 'browser-token-123456789' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe(`${origin}/api/human/messaging/participants`);
    expect(fetch.mock.calls[0]![1]?.method).toBe('POST');
    expect(result?.size).toBe(entries.length);
    expect(result?.get('@stranger:hs')).toEqual({ participantId: 'unknown:@stranger:hs', ownerId: 'unknown:@stranger:hs',
      kind: 'human', displayName: 'Unknown', deviceIds: [] });
    expect(api.participants.describe('unknown:@stranger:hs')).toEqual(entries.at(-1));
    if (!unknownOnly) {
      expect(result?.get('@maya:hs')).toMatchObject({ participantId: 'human_maya', ownerId: 'owner_maya', displayName: 'Maya' });
      expect(result?.get('@bot:hs')).toMatchObject({ participantId: 'agent_bot', ownerId: 'owner_kevin', kind: 'agent', displayName: 'Claude · Kevin' });
      expect(api.participants.describe('agent_bot')).toMatchObject({ harness: 'claude' });
    }
  });

  it.each([
    { matrixUserId: '@bot:hs', participantId: 'agent_bot', ownerId: 'owner_bob', displayName: 'Bot', kind: 'agent', harness: 'codex' },
    { matrixUserId: '@bot:hs', participantId: 'human_bob', ownerId: 'owner_bob', displayName: 'Bob', kind: 'human', harness: 'codex' },
  ])('rejects malformed C3 entries without publishing details', async entry => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(200, { principal, csrfToken: 'csrf-proof' }))
      .mockResolvedValueOnce(json(200, { participants: [entry] }));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch });
    expect(await api.participants.resolve(['@bot:hs'])).toBeNull();
    expect(api.participants.describe(entry.participantId)).toBeUndefined();
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
          kind: 'human',
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
        participantId: 'agent_420', ownerId: 'owner_bob', displayName: 'Codex #420', kind: 'agent', ownerLabel: 'Bob', harness: 'codex' }] }));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch });
    const session = { deviceId: 'WEB_DEVICE', matrixAccessToken: 'browser-token-123456789' };
    const participants = await api.participants.resolve([userId], undefined, 'room_1' as RoomId, undefined, session);
    expect(participants?.get(userId)).toMatchObject({ kind: 'agent', participantId: 'agent_420', ownerId: 'owner_bob' });
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ userIds: [userId], roomId: 'room_1', ...session }));
    expect(await api.participants.resolve([userId], undefined, 'room_1' as RoomId)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('resolves a departed rename target by participant ID within the authorized room', async () => {
    const userId = '@owner:matrix.example.test';
    const targetId = 'agent_departed' as never;
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(200, { principal, csrfToken: 'csrf-proof' }))
      .mockResolvedValueOnce(json(200, { participants: [
        { matrixUserId: userId, participantId: 'human_owner', ownerId: 'owner_bob', displayName: 'Maya', kind: 'human' },
        { matrixUserId: '@departed:matrix.example.test', participantId: targetId, ownerId: 'owner_bob', displayName: 'Codex #420', kind: 'agent', ownerLabel: 'Bob', harness: 'codex' },
      ] }));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch });
    const session = { deviceId: 'WEB_DEVICE', matrixAccessToken: 'browser-token-123456789' };
    const resolved = await api.participants.resolve([userId], undefined, 'room_1' as RoomId, [targetId], session);
    expect(resolved?.get('@departed:matrix.example.test')).toMatchObject({ participantId: targetId, kind: 'agent' });
    expect(JSON.parse(String(fetch.mock.calls[1]![1]!.body))).toEqual({ userIds: [userId], roomId: 'room_1', targetParticipantIds: [targetId], ...session });
  });

  it('distinguishes an omitted target in a successful response from lookup failure', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(200, { principal, csrfToken: 'csrf-proof' }))
      .mockResolvedValueOnce(json(200, { participants: [] }))
      .mockResolvedValueOnce(json(503, {}));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch });
    const session = { deviceId: 'WEB_DEVICE', matrixAccessToken: 'browser-token-123456789' };
    expect(await api.participants.resolve([], undefined, 'room_1' as RoomId, ['agent_unknown' as never], session)).toEqual(new Map());
    expect(await api.participants.resolve([], undefined, 'room_1' as RoomId, ['agent_unknown' as never], session)).toBeNull();
  });

});

describe('agent join browser API', () => {
  const view = { joinId: 'j1', label: 'Helper', harness: 'claude', channelName: 'Launch', roomId: '!r1:khala.local', state: 'pending' };
  it.each(['view', 'status'] as const)('decodes %s and forwards the abort signal on a same-origin GET', async method => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(200, view));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch });
    const abort = new AbortController();
    expect(await api.agentJoin[method]('j1', abort.signal)).toEqual({ kind: 'ok', view });
    expect(fetch.mock.calls[0]?.[0]).toBe(`${origin}/api/human/agent-join${method === 'status' ? '/status' : ''}?joinId=j1`);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', credentials: 'same-origin' });
    abort.abort();
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
  it.each([[401, 'signed_out'], [403, 'not_member'], [404, 'not_found'], [409, 'already_confirmed_by_other'], [500, 'unavailable']] as const)('maps HTTP %s', async (status, code) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(status, { error: code }));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch });
    expect(await api.agentJoin.view('j1')).toEqual({ kind: 'error', code });
    expect(await api.agentJoin.status('j1')).toEqual({ kind: 'error', code });
  });
  it.each([{ ...view, harness: 'unknown' }, { ...view, roomId: 'bad' }, {}, { ...view, extra: true }])('rejects malformed views', async body => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(200, body));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch });
    expect(await api.agentJoin.view('j1')).toEqual({ kind: 'error', code: 'unavailable' });
  });
  it('posts an empty confirmation body using the current CSRF token', async () => {
    const confirmed = { ...view, state: 'confirmed', agentUserId: '@agent-x:hs' };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(200, { principal, csrfToken: 'current-proof' }))
      .mockResolvedValueOnce(json(200, confirmed));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch });
    expect(await api.agentJoin.confirm('j1')).toEqual({ kind: 'ok', view: confirmed });
    expect(fetch.mock.calls[1]?.[0]).toBe(`${origin}/api/human/agent-join/confirm?joinId=j1`);
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', credentials: 'same-origin', body: '{}' });
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get('x-khala-csrf')).toBe('current-proof');
  });
  it('returns unavailable on network failures and encodes query identifiers', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('offline'));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch });
    expect(await api.agentJoin.view('a&b')).toEqual({ kind: 'error', code: 'unavailable' });
    expect(fetch.mock.calls[0]?.[0]).toBe(`${origin}/api/human/agent-join?joinId=a%26b`);
  });
  it('retains the confirmation return path when signing in', async () => {
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch: vi.fn() });
    const result = await api.identity.beginSignIn('/agent/confirm?joinId=j1');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok' && result.value.kind === 'navigate') {
      expect(new URL(result.value.url).searchParams.get('return_to')).toBe('/agent/confirm?joinId=j1');
    }
  });
});


describe('human profile adapter', () => {
  it('decodes profile reads and sends username mutations with CSRF', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(200, { username: null, suggestion: 'Kevin' }))
      .mockResolvedValueOnce(json(200, { principal, csrfToken: 'csrf-proof' }))
      .mockResolvedValueOnce(json(200, { username: 'Kevin' }));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch });
    expect(await api.profile.get()).toEqual({ kind: 'ok', username: null, suggestion: 'Kevin' });
    expect(await api.profile.setUsername('Kevin')).toEqual({ kind: 'ok', username: 'Kevin' });
    expect(fetch.mock.calls[0]?.[0]).toBe(`${origin}/api/human/profile`);
    expect(fetch.mock.calls[2]?.[0]).toBe(`${origin}/api/human/profile/username`);
    expect(fetch.mock.calls[2]?.[1]?.body).toBe(JSON.stringify({ username: 'Kevin' }));
    expect(fetch.mock.calls[2]?.[1]?.credentials).toBe('same-origin');
    expect(new Headers(fetch.mock.calls[2]?.[1]?.headers).get('x-khala-csrf')).toBe('csrf-proof');
  });

  it.each([
    [400, { error: 'invalid_username', reason: 'too_short' }, { kind: 'error', code: 'invalid_username', reason: 'too_short' }],
    [400, { error: 'invalid_username', reason: 'invented' }, { kind: 'error', code: 'invalid_username' }],
    [409, { error: 'username_taken' }, { kind: 'error', code: 'username_taken' }],
    [401, { error: 'signed_out' }, { kind: 'error', code: 'signed_out' }],
    [503, { error: 'unavailable' }, { kind: 'error', code: 'unavailable' }],
    [403, { error: 'csrf_mismatch' }, { kind: 'error', code: 'unavailable' }],
  ])('maps username mutation status %s to finite errors', async (status, body, expected) => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(200, { principal, csrfToken: 'csrf-proof' }))
      .mockResolvedValueOnce(json(status, body));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch });
    expect(await api.profile.setUsername('Kevin')).toEqual(expected);
  });

  it.each([401, 503])('maps profile read status %s', async status => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(status, {}));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch });
    expect(await api.profile.get()).toEqual({ kind: 'error', code: status === 401 ? 'signed_out' : 'unavailable' });
  });

  it('preserves signed-out preflight and does not send a mutation', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(401, {}));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch });
    expect(await api.profile.setUsername('Kevin')).toEqual({ kind: 'error', code: 'signed_out' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([{ username: 'Kevin', extra: true }, { username: 'admin' }, { username: ' Kevin ' }])('rejects malformed mutation success %j', async body => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(200, { principal, csrfToken: 'csrf-proof' }))
      .mockResolvedValueOnce(json(200, body));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch });
    expect(await api.profile.setUsername('Kevin')).toEqual({ kind: 'error', code: 'unavailable' });
  });

  it('rejects malformed profile read success', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(200, { username: null, suggestion: 'Kevin', extra: true }));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch });
    expect(await api.profile.get()).toEqual({ kind: 'error', code: 'unavailable' });
  });
});

describe('agent name adapter', () => {
  const matrixUserId = '@agent:matrix.test';

  it('sends the rename mutation with the current CSRF token', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(200, { principal, csrfToken: 'csrf-proof' }))
      .mockResolvedValueOnce(json(200, { matrixUserId, name: 'Reviewer' }));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch });
    expect(await api.agentNames.rename(matrixUserId, 'Reviewer')).toEqual({ kind: 'ok', name: 'Reviewer' });
    const [url, init] = fetch.mock.calls[1]!;
    expect(url).toBe(`${origin}/api/human/agents/rename`);
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('same-origin');
    expect(JSON.parse(init?.body as string)).toEqual({ matrixUserId, name: 'Reviewer' });
    expect(new Headers(init?.headers).get('x-khala-csrf')).toBe('csrf-proof');
  });

  it.each([
    [400, { error: 'invalid_name', reason: 'invalid_characters' }, { kind: 'error', code: 'invalid_name', reason: 'invalid_characters' }],
    [400, { error: 'invalid_name', reason: 'invented' }, { kind: 'error', code: 'invalid_name' }],
    [400, { error: 'invalid_request' }, { kind: 'error', code: 'unavailable' }],
    [403, { error: 'not_owner' }, { kind: 'error', code: 'not_owner' }],
    [403, { error: 'csrf_mismatch' }, { kind: 'error', code: 'unavailable' }],
    [403, { error: 'forbidden_origin' }, { kind: 'error', code: 'unavailable' }],
    [404, { error: 'not_found' }, { kind: 'error', code: 'not_found' }],
    [409, { error: 'name_taken' }, { kind: 'error', code: 'name_taken' }],
    [401, { error: 'signed_out' }, { kind: 'error', code: 'signed_out' }],
    [503, { error: 'unavailable' }, { kind: 'error', code: 'unavailable' }],
  ])('maps rename status %s and body %j', async (status, body, expected) => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(200, { principal, csrfToken: 'csrf-proof' }))
      .mockResolvedValueOnce(json(status, body));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch });
    expect(await api.agentNames.rename(matrixUserId, 'Reviewer')).toEqual(expected);
  });

  it.each([
    { matrixUserId, name: 'Reviewer', extra: true },
    { matrixUserId, name: ' Reviewer ' },
    { matrixUserId, name: 'ab cd' },
    { matrixUserId: '@other:matrix.test', name: 'Reviewer' },
  ])('rejects malformed or mismatched rename success %j', async body => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(200, { principal, csrfToken: 'csrf-proof' }))
      .mockResolvedValueOnce(json(200, body));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch });
    expect(await api.agentNames.rename(matrixUserId, 'Reviewer')).toEqual({ kind: 'error', code: 'unavailable' });
  });

  it('preserves signed-out preflight without sending a rename', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(401, { error: 'signed_out' }));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch });
    expect(await api.agentNames.rename(matrixUserId, 'Reviewer')).toEqual({ kind: 'error', code: 'signed_out' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns unavailable on transport failure', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(200, { principal, csrfToken: 'csrf-proof' }))
      .mockRejectedValueOnce(new Error('offline'));
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch });
    expect(await api.agentNames.rename(matrixUserId, 'Reviewer')).toEqual({ kind: 'error', code: 'unavailable' });
  });
});
