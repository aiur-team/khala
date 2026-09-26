import { describe, expect, it, vi } from 'vitest';
import { decodeContentLimits, type ChannelAccessRequestHandle, type DeviceId, type OwnerId, type RoomId } from '@khala/contracts/messaging/index';
import { createHumanBrowserApi } from './browser-api';

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
    const api = createHumanBrowserApi({ origin, homeserverOrigin, limits, fetch, deviceIds });

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
});
