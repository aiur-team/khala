import { describe, expect, it } from 'vitest';
import type { ChannelAccessRequesterContext, DiscoveryRequester } from '@khala/contracts/messaging/index';
import { resolveAgentChannelLink } from './link';
import { ORIGIN, ROOM_ID, SECRET, harness, principal } from './support.test';

const requester: DiscoveryRequester = {
  principal: 'agent_session_1' as DiscoveryRequester['principal'], origin: ORIGIN,
  proofKey: { algorithm: 'Ed25519', publicKey: 'b'.repeat(43), thumbprint: 'c'.repeat(43) },
  sessionGeneration: 3,
};
const context: ChannelAccessRequesterContext = {
  v: 1, principal: requester.principal, origin: ORIGIN, sessionGeneration: 3,
  sessionFingerprint: 'fingerprint', harness: 'codex', displayLabel: null, workspaceLabel: null,
};

describe('personal channel links', () => {
  it('lets A use A’s link and B join through it, then gives B a stable distinct agent link', async () => {
    const h = harness();
    h.memberships.set(principal().ownerId, { roomId: ROOM_ID, title: 'Room', membership: 'joined', revision: 'm1' });
    const a = await h.service.personalLink(ROOM_ID);
    expect(a.kind).toBe('ok');
    if (a.kind !== 'ok') return;
    const resolve = (url: string, sponsor = principal(), native = context) => resolveAgentChannelLink({
      channelUrl: url, origin: ORIGIN, store: h.store.store, secret: SECRET,
      clock: () => Date.parse('2026-09-18T12:00:00Z'), sponsorOwnerId: sponsor.ownerId, requester, context: native,
      inspectMembership: (ownerId, roomId) => h.memberships.get(ownerId)?.roomId === roomId
        ? Promise.resolve({ kind: 'joined', historyReady: true }) : Promise.resolve({ kind: 'absent' }),
    });
    expect(await resolve(a.value.shareUrl)).toMatchObject({ kind: 'resolved', roomId: ROOM_ID });

    const b = principal('owner_b', 'b@example.test');
    h.setPrincipal(b);
    expect(await h.service.inspect(a.value.inviteRef)).toBe('eligible');
    expect((await h.service.admit({ operationId: 'join_b', inviteRef: a.value.inviteRef, deviceId: 'device_b' as never })).kind).toBe('ok');
    const [own, retry, concurrent] = await Promise.all([
      h.service.personalLink(ROOM_ID), h.service.personalLink(ROOM_ID), h.service.personalLink(ROOM_ID),
    ]);
    expect(retry).toEqual(own);
    expect(concurrent).toEqual(own);
    expect(own.kind).toBe('ok');
    if (own.kind !== 'ok') return;
    expect(own.value.shareUrl).not.toBe(a.value.shareUrl);
    expect(await resolve(a.value.shareUrl, b)).toEqual({ kind: 'use_your_link' });
    expect(await resolve(own.value.shareUrl, b)).toMatchObject({ kind: 'resolved', roomId: ROOM_ID });
    expect(await resolve(own.value.shareUrl, b, { ...context, sessionGeneration: 4 })).toEqual({ kind: 'forbidden' });
  });

  it('fails closed for revoked, expired and cross-origin links', async () => {
    const h = harness();
    h.memberships.set(principal().ownerId, { roomId: ROOM_ID, title: 'Room', membership: 'joined', revision: 'm1' });
    const link = await h.service.personalLink(ROOM_ID);
    expect(link.kind).toBe('ok');
    if (link.kind !== 'ok') return;
    const resolve = (url: string, now: number) => resolveAgentChannelLink({
      channelUrl: url, origin: ORIGIN, store: h.store.store, secret: SECRET, clock: () => now,
      sponsorOwnerId: principal().ownerId, requester, context,
      inspectMembership: async () => ({ kind: 'joined', historyReady: true }),
    });
    expect(await resolve(link.value.shareUrl.replace(ORIGIN, 'https://evil.example'), 0)).toEqual({ kind: 'invalid_link' });
    expect(await resolve(link.value.shareUrl, Date.parse('2026-09-18T13:00:00Z'))).toEqual({ kind: 'expired' });
    expect((await h.service.revoke({ operationId: 'revoke_link', inviteRef: link.value.inviteRef })).kind).toBe('ok');
    expect(await resolve(link.value.shareUrl, 0)).toEqual({ kind: 'revoked' });
    const [replacement, concurrent] = await Promise.all([h.service.personalLink(ROOM_ID), h.service.personalLink(ROOM_ID)]);
    expect(replacement).toEqual(concurrent);
    expect(replacement.kind).toBe('ok');
    if (replacement.kind === 'ok') expect(replacement.value.shareUrl).not.toBe(link.value.shareUrl);
    h.advance(3600_000);
    const afterExpiry = await h.service.personalLink(ROOM_ID);
    expect(afterExpiry.kind).toBe('ok');
    if (replacement.kind === 'ok' && afterExpiry.kind === 'ok') {
      expect(afterExpiry.value.shareUrl).not.toBe(replacement.value.shareUrl);
    }
  });

  it('does not turn a history-enabled human share into an agent request', async () => {
    const h = harness();
    h.memberships.set(principal().ownerId, { roomId: ROOM_ID, title: 'Room', membership: 'joined', revision: 'm1' });
    const shared = await h.service.share({ operationId: 'human-history', roomId: ROOM_ID,
      policy: { v: 1, kind: 'link', history: 'full' } });
    expect(shared.kind).toBe('ok');
    if (shared.kind !== 'ok') return;
    expect(await resolveAgentChannelLink({
      channelUrl: shared.value.shareUrl, origin: ORIGIN, store: h.store.store, secret: SECRET,
      clock: () => Date.parse('2026-09-18T12:00:00Z'), sponsorOwnerId: principal().ownerId,
      requester, context, inspectMembership: async () => ({ kind: 'joined', historyReady: true }),
    })).toEqual({ kind: 'forbidden' });
  });
});
