import { expect, it, vi } from 'vitest';
import { DEVICE_ID, ROOM_ID, harness, principal } from './support.test';
import { recordRemoval, completeRemoval } from './removals';
import { resolveJoinLink } from '../agent-join/store';
import { ORIGIN, SECRET } from './support.test';
import { createAgentSessionStatusHandler, rememberAgentSession } from '../agent-join/session-status';

it('blocks old links and committed admission replay, rotates owner personal links, and revokes removed issuer links', async () => {
  const h = harness();
  const owner = principal(); const target = principal('recipient');
  const old = await h.service.personalLink(ROOM_ID);
  expect(old.kind).toBe('ok'); if (old.kind !== 'ok') throw new Error('share');
  h.setPrincipal(target);
  expect((await h.service.admit({ operationId: 'join', inviteRef: old.value.inviteRef, deviceId: DEVICE_ID })).kind).toBe('ok');
  const issued = await h.service.share({ operationId: 'recipient-link', roomId: ROOM_ID });
  if (issued.kind !== 'ok') throw new Error('share');
  expect(await recordRemoval(h.store.store, ROOM_ID, owner.ownerId, target.ownerId, ['@agent:matrix.test'], 'Recipient')).not.toBe('unavailable');
  await completeRemoval(h.store.store, ROOM_ID, target.ownerId, 1);
  h.memberships.delete(target.ownerId);
  expect(await h.service.inspect(old.value.inviteRef)).toBe('revoked');
  expect(await h.service.admit({ operationId: 'join', inviteRef: old.value.inviteRef, deviceId: DEVICE_ID })).toEqual({ kind: 'rejected', code: 'revoked' });
  expect(await h.service.admit({ operationId: 'join-again', inviteRef: old.value.inviteRef, deviceId: DEVICE_ID })).toEqual({ kind: 'rejected', code: 'revoked' });
  h.setPrincipal(principal('unaffected'));
  expect(await h.service.inspect(old.value.inviteRef)).toBe('eligible');
  expect(await h.service.inspect(issued.value.inviteRef)).toBe('revoked');
  expect(await resolveJoinLink({ link: issued.value.shareUrl, origin: ORIGIN, secret: SECRET, store: h.store.store, clock: () => 0 })).toEqual({ kind: 'link_unavailable' });
  const byOther = await h.service.share({ operationId: 'other-new', roomId: ROOM_ID });
  if (byOther.kind !== 'ok') throw new Error('share');
  h.setPrincipal(target);
  expect(await h.service.inspect(byOther.value.inviteRef)).toBe('revoked');
  h.setPrincipal(owner);
  const fresh = await h.service.personalLink(ROOM_ID);
  if (fresh.kind !== 'ok') throw new Error('share');
  expect(fresh.value.inviteRef).not.toBe(old.value.inviteRef);
  h.setPrincipal(target);
  expect(await h.service.inspect(fresh.value.inviteRef)).toBe('eligible');
  expect((await h.service.admit({ operationId: 'new-join', inviteRef: fresh.value.inviteRef, deviceId: DEVICE_ID })).kind).toBe('ok');
});

it('recognizes removed agent tokens, keeps other and freshly reissued tokens usable, and never stores the bearer', async () => {
  const h = harness(); const owner = principal(); const target = principal('recipient');
  const credentials = { homeserver: 'https://matrix.test', userId: '@agent:matrix.test', roomId: ROOM_ID, deviceId: 'device', accessToken: 'original-secret-bearer' };
  expect(await rememberAgentSession(h.store.store, credentials)).toBe(true);
  const status = createAgentSessionStatusHandler(h.store.store);
  const request = (token: string) => new Request('https://control.test/api/agent/session/status', { headers: { authorization: `Bearer ${token}` } });
  expect(await (await status(request(credentials.accessToken))).json()).toEqual({ removed: false });
  await recordRemoval(h.store.store, ROOM_ID, owner.ownerId, target.ownerId, [credentials.userId], 'Recipient');
  expect(await (await status(request(credentials.accessToken))).json()).toEqual({ removed: true });
  expect((await status(request('unknown'))).status).toBe(401);
  const fresh = { ...credentials, accessToken: 'new-secret-bearer' };
  expect(await rememberAgentSession(h.store.store, fresh)).toBe(true);
  expect(await (await status(request(fresh.accessToken))).json()).toEqual({ removed: false });
  expect(JSON.stringify([...h.store.records.values()])).not.toContain(credentials.accessToken);
});


it('checks exact legacy agent identity and distinguishes revoked bearers from healthy readmission', async () => {
  const h = harness(); const owner = principal(); const target = principal('recipient');
  const userId = '@legacy:matrix.test';
  await recordRemoval(h.store.store, ROOM_ID, owner.ownerId, target.ownerId, [userId], 'Recipient');
  await completeRemoval(h.store.store, ROOM_ID, target.ownerId, 1);
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const token = new Headers(init?.headers).get('authorization');
    return token === 'Bearer healthy' ? new Response(JSON.stringify({ user_id: userId, device_id: 'device' }))
      : new Response(JSON.stringify({ errcode: 'M_UNKNOWN_TOKEN' }), { status: 401 });
  });
  const status = createAgentSessionStatusHandler(h.store.store, { homeserverOrigin: 'https://matrix.test', fetch });
  const request = (token: string, user = userId, room: string = ROOM_ID) => {
    const url = new URL('https://control.test/api/agent/session/status');
    url.searchParams.set('userId', user); url.searchParams.set('roomId', room);
    return new Request(url, { headers: { authorization: `Bearer ${token}` } });
  };
  expect((await status(request('revoked'))).status).toBe(401);
  expect(await (await status(request('healthy'))).json()).toEqual({ removed: false });
  expect(await (await status(request('healthy'))).json()).toEqual({ removed: false });
  expect(fetch).toHaveBeenCalledTimes(2); // The healthy bearer was verified once and durably indexed.
  expect((await status(request('revoked', '@arbitrary:matrix.test'))).status).toBe(401);
  expect((await status(request('revoked', userId, 'other-room'))).status).toBe(401);
  expect(await (await status(request('healthy', '@arbitrary:matrix.test'))).json()).toEqual({ removed: false });
});

it('authenticates unknown and missing tokens identically for removed and active agents', async () => {
  const h = harness();
  const userId = '@agent:matrix.test';
  const credentials = { homeserver: 'https://matrix.test', userId, roomId: ROOM_ID, deviceId: 'device', accessToken: 'valid' };
  await rememberAgentSession(h.store.store, credentials);
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{}', { status: 401 }));
  const status = createAgentSessionStatusHandler(h.store.store, { homeserverOrigin: 'https://matrix.test', fetch });
  const request = (token?: string) => new Request(`https://control.test/api/agent/session/status?roomId=${encodeURIComponent(ROOM_ID)}&userId=${encodeURIComponent(userId)}`,
    { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const active = await status(request('invalid'));
  expect(active.status).toBe(401);
  const activeBody = await active.json();
  await recordRemoval(h.store.store, ROOM_ID, principal().ownerId, principal('recipient').ownerId, [userId], 'Recipient');
  const removed = await status(request('invalid'));
  expect(removed.status).toBe(401);
  expect(await removed.json()).toEqual(activeBody);
  expect((await status(request())).status).toBe(401);
  expect(await (await status(request('valid'))).json()).toEqual({ removed: true });
});

it('only discloses incomplete legacy removal after whoami authenticates the claimed agent', async () => {
  const h = harness();
  const userId = '@legacy:matrix.test';
  await recordRemoval(h.store.store, ROOM_ID, principal().ownerId, principal('recipient').ownerId, [userId], 'Recipient');
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ user_id: userId })));
  const status = createAgentSessionStatusHandler(h.store.store, { homeserverOrigin: 'https://matrix.test', fetch });
  const url = `https://control.test/api/agent/session/status?roomId=${encodeURIComponent(ROOM_ID)}&userId=${encodeURIComponent(userId)}`;
  expect(await (await status(new Request(url, { headers: { authorization: 'Bearer verified' } }))).json()).toEqual({ removed: true });
  expect(fetch).toHaveBeenCalledOnce();
});
