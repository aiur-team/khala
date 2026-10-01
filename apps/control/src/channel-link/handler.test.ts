import { describe, expect, it } from 'vitest';
import type { ChannelAccessRequesterContext, DiscoveryRequester } from '@khala/contracts/messaging/index';
import { ORIGIN, ROOM_ID, SECRET, harness, principal } from '../invitations/support.test';
import {
  AGENT_CHANNEL_LINK_REQUEST_PATH, HUMAN_CHANNEL_LINK_PERSONAL_PATH,
  HUMAN_CHANNEL_LINK_RESOLVE_PATH, createChannelLinkHandlers,
} from './handler';

const requester: DiscoveryRequester = {
  principal: 'agent_session_1' as DiscoveryRequester['principal'], origin: ORIGIN,
  proofKey: { algorithm: 'Ed25519', publicKey: 'b'.repeat(43), thumbprint: 'c'.repeat(43) },
  sessionGeneration: 2,
};
const context: ChannelAccessRequesterContext = {
  v: 1, principal: requester.principal, origin: ORIGIN, sessionGeneration: 2,
  sessionFingerprint: 'exact_native_session', harness: 'codex', displayLabel: null, workspaceLabel: null,
};

function post(path: string, body: unknown): Request {
  return new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

function setup() {
  const h = harness();
  const a = principal();
  let human = a;
  let agent = a;
  let authenticated = true;
  let requesterState: 'current' | 'revoked' | 'unavailable' = 'current';
  let now = Date.parse('2026-09-18T12:00:00Z');
  const submitted: unknown[] = [];
  h.memberships.set(a.ownerId, { roomId: ROOM_ID, title: 'Room', membership: 'joined', revision: 'm1' });
  const routes = createChannelLinkHandlers({
    origin: ORIGIN, store: h.store.store, secret: SECRET, clock: () => now,
    auth: {
      authenticateRequest: async () => authenticated
        ? { kind: 'authenticated', context: { principal: human, csrfToken: 'csrf' } } as never
        : { kind: 'signed_out' } as never,
      requireHumanMutation: async () => authenticated
        ? { kind: 'authorized', context: { principal: human, csrfToken: 'csrf' } } as never
        : { kind: 'rejected', code: 'signed_out' } as never,
    },
    admissionFor: () => h.service,
    agent: {
      authenticate: async () => authenticated
        ? { kind: 'authenticated', credentialRef: 'credential_b', sponsorOwnerId: agent.ownerId, requester, context }
        : { kind: 'rejected', code: 'auth_required' },
      inspectRequester: async () => requesterState,
      inspectMembership: async (ownerId, room) => h.memberships.get(ownerId)?.roomId === room
        ? { kind: 'joined', historyReady: true } : { kind: 'absent' },
      async submitAccess(input) {
        submitted.push(input);
        return { v: 1, operationId: input.operationId, outcome: 'pending_owner' };
      },
    },
  });
  const route = (path: string) => [...routes.human, ...routes.agent].find(item => item.path === path)!;
  return { h, route, submitted, setHuman(value: typeof a) { human = value; h.setPrincipal(value); },
    setAgent(value: typeof a) { agent = value; }, signOut() { authenticated = false; },
    setRequesterState(value: typeof requesterState) { requesterState = value; },
    setNow(value: number) { now = value; } };
}

describe('channel-link routes', () => {
  it('resolves browser identity from the session, then issues a personal link for a joined B', async () => {
    const t = setup();
    const shared = await t.h.service.personalLink(ROOM_ID);
    expect(shared.kind).toBe('ok');
    if (shared.kind !== 'ok') return;
    const b = principal('owner_b', 'b@example.test');
    t.setHuman(b);
    const resolve = t.route(HUMAN_CHANNEL_LINK_RESOLVE_PATH);
    expect(await (await resolve.handle(post(resolve.path, { v: 1, channelUrl: shared.value.shareUrl }))).json())
      .toEqual({ v: 1, kind: 'join_required' });
    await t.h.service.admit({ operationId: 'join_b', inviteRef: shared.value.inviteRef, deviceId: 'device_b' as never });
    expect(await (await resolve.handle(post(resolve.path, { v: 1, channelUrl: shared.value.shareUrl }))).json())
      .toEqual({ v: 1, kind: 'joined' });
    const personal = t.route(HUMAN_CHANNEL_LINK_PERSONAL_PATH);
    const own = await (await personal.handle(post(personal.path, { v: 1, roomId: ROOM_ID }))).json() as { shareUrl: string };
    expect(own).toMatchObject({ v: 1, kind: 'personal_link', shareUrl: expect.stringContaining('/join/') });
    expect(own.shareUrl).not.toBe(shared.value.shareUrl);
  });

  it('never submits B’s agent with A’s link and files one pending request with B’s link', async () => {
    const t = setup();
    const a = await t.h.service.personalLink(ROOM_ID);
    expect(a.kind).toBe('ok');
    if (a.kind !== 'ok') return;
    const b = principal('owner_b', 'b@example.test');
    t.setHuman(b);
    await t.h.service.admit({ operationId: 'join_b', inviteRef: a.value.inviteRef, deviceId: 'device_b' as never });
    const own = await t.h.service.personalLink(ROOM_ID);
    expect(own.kind).toBe('ok');
    if (own.kind !== 'ok') return;
    t.setAgent(b);
    const route = t.route(AGENT_CHANNEL_LINK_REQUEST_PATH);
    const body = (channelUrl: string) => ({ v: 1, kind: 'channel_url', operationId: 'request_b', credentialRef: 'credential_b', channelUrl });
    const wrong = await route.handle(post(route.path, body(a.value.shareUrl)));
    expect(wrong.status).toBe(409);
    expect(await wrong.json()).toEqual({ v: 1, kind: 'use_your_link', action: 'join_in_browser_then_copy_your_link' });
    expect(t.submitted).toHaveLength(0);
    expect((await route.handle(post(route.path, { ...body(own.value.shareUrl), credentialRef: 'credential_a' }))).status).toBe(403);
    expect(t.submitted).toHaveLength(0);
    const right = await route.handle(post(route.path, body(own.value.shareUrl)));
    const rightText = await right.clone().text();
    expect(await right.json()).toEqual({ v: 1, kind: 'request', operationId: 'request_b', outcome: 'pending_owner' });
    expect(t.submitted).toHaveLength(1);
    expect(rightText).not.toContain(ROOM_ID);
  });

  it('refuses unauthenticated requests before reading link data', async () => {
    const t = setup();
    t.signOut();
    const human = t.route(HUMAN_CHANNEL_LINK_RESOLVE_PATH);
    const agent = t.route(AGENT_CHANNEL_LINK_REQUEST_PATH);
    expect((await human.handle(post(human.path, { v: 1, channelUrl: `${ORIGIN}/join/unknown` }))).status).toBe(401);
    expect((await agent.handle(post(agent.path, { v: 1, kind: 'channel_url', operationId: 'op', credentialRef: 'cred', channelUrl: `${ORIGIN}/join/unknown` }))).status).toBe(401);
    expect(t.submitted).toHaveLength(0);
  });

  it('refuses a missing or untrusted exact session before reading a valid link', async () => {
    const t = setup();
    const shared = await t.h.service.personalLink(ROOM_ID);
    expect(shared.kind).toBe('ok');
    if (shared.kind !== 'ok') return;
    const route = t.route(AGENT_CHANNEL_LINK_REQUEST_PATH);
    const request = () => route.handle(post(route.path, { v: 1, kind: 'channel_url',
      operationId: 'untrusted_session', credentialRef: 'credential_b', channelUrl: shared.value.shareUrl }));
    t.setRequesterState('revoked');
    expect(await (await request()).json()).toEqual({ v: 1, kind: 'forbidden' });
    t.setRequesterState('unavailable');
    expect(await (await request()).json()).toEqual({ v: 1, kind: 'unavailable' });
    expect(t.submitted).toHaveLength(0);
  });

  it('refuses expired and revoked links without submitting an owner request', async () => {
    const t = setup();
    const shared = await t.h.service.personalLink(ROOM_ID);
    expect(shared.kind).toBe('ok');
    if (shared.kind !== 'ok') return;
    const route = t.route(AGENT_CHANNEL_LINK_REQUEST_PATH);
    const body = { v: 1, kind: 'channel_url', operationId: 'expired_link',
      credentialRef: 'credential_b', channelUrl: shared.value.shareUrl };
    t.setNow(Date.parse('2026-09-18T13:00:00Z'));
    expect(await (await route.handle(post(route.path, body))).json()).toEqual({ v: 1, kind: 'expired' });
    t.setNow(Date.parse('2026-09-18T12:00:00Z'));
    expect((await t.h.service.revoke({ operationId: 'revoke_link', inviteRef: shared.value.inviteRef })).kind).toBe('ok');
    expect(await (await route.handle(post(route.path, body))).json()).toEqual({ v: 1, kind: 'revoked' });
    expect(t.submitted).toHaveLength(0);
  });
});
