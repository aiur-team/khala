import { describe, expect, it } from 'vitest';
import { ORIGIN, ROOM_ID, SECRET, harness, principal } from '../invitations/support.test';
import {
  HUMAN_CHANNEL_LINK_PERSONAL_PATH,
  HUMAN_CHANNEL_LINK_RESOLVE_PATH, createChannelLinkHandlers,
} from './handler';

function post(path: string, body: unknown): Request {
  return new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

function setup() {
  const h = harness();
  const a = principal();
  let human = a;
  let authenticated = true;
  let now = Date.parse('2026-09-18T12:00:00Z');
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
  });
  const route = (path: string) => routes.human.find(item => item.path === path)!;
  return { h, route, routes, setHuman(value: typeof a) { human = value; h.setPrincipal(value); },
    signOut() { authenticated = false; },
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

  it('refuses unauthenticated requests before reading link data', async () => {
    const t = setup();
    t.signOut();
    const human = t.route(HUMAN_CHANNEL_LINK_RESOLVE_PATH);
    expect((await human.handle(post(human.path, { v: 1, channelUrl: `${ORIGIN}/join/unknown` }))).status).toBe(401);
  });

  it('exposes only the human handlers', () => {
    expect(Object.keys(setup().routes)).toEqual(['human']);
  });
});
