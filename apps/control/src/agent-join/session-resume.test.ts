import { expect, it, vi } from 'vitest';
import { harness, principal, ROOM_ID } from '../invitations/support.test';
import { recordRemoval } from '../invitations/removals';
import { createAgentSessionResumeHandler, rememberAgentSession } from './session-status';
import type { AgentProvisioner } from './provision';

const old = { homeserver: 'https://matrix.test', userId: '@agent:matrix.test', roomId: ROOM_ID, deviceId: 'old', accessToken: 'old-token' };
const fresh = { ...old, deviceId: 'new', accessToken: 'new-token' };
const request = (token = old.accessToken) => new Request('https://control.test/api/agent/session/resume', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
async function fixture() {
  const h = harness();
  await rememberAgentSession(h.store.store, old);
  const resume = vi.fn(async () => ({ kind: 'ok' as const, credentials: fresh }));
  const provisioner = { resume } as unknown as AgentProvisioner;
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ user_id: old.userId }));
  return { h, resume, fetch, handler: createAgentSessionResumeHandler(h.store.store, { homeserverOrigin: old.homeserver, provisioner, fetch }) };
}
it('refreshes only the indexed identity and binds the new bearer to its removal generation', async () => {
  const f = await fixture();
  const response = await f.handler(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(fresh);
  expect(f.resume).toHaveBeenCalledExactlyOnceWith({ userId: old.userId, roomId: ROOM_ID });
  await recordRemoval(f.h.store.store, ROOM_ID, principal().ownerId, principal('recipient').ownerId, [old.userId], 'Recipient');
  expect((await f.handler(request(fresh.accessToken))).status).toBe(403);
});
it.each(['unknown', 'revoked', 'removed', 'wrong-user'])('does not issue a device for %s authorization', async reason => {
  const f = await fixture();
  if (reason === 'revoked') f.fetch.mockResolvedValue(new Response('{}', { status: 401 }));
  if (reason === 'wrong-user') f.fetch.mockResolvedValue(Response.json({ user_id: '@other:matrix.test' }));
  if (reason === 'removed') await recordRemoval(f.h.store.store, ROOM_ID, principal().ownerId, principal('recipient').ownerId, [old.userId], 'Recipient');
  const response = await f.handler(request(reason === 'unknown' ? 'unknown-token' : old.accessToken));
  expect(response.status).toBe(reason === 'removed' ? 403 : 401);
  expect(f.resume).not.toHaveBeenCalled();
});
it('withholds and logs out a device issued concurrently with removal', async () => {
  const f = await fixture();
  f.resume.mockImplementation(async () => {
    await recordRemoval(f.h.store.store, ROOM_ID, principal().ownerId, principal('recipient').ownerId, [old.userId], 'Recipient');
    return { kind: 'ok', credentials: fresh };
  });
  expect((await f.handler(request())).status).toBe(403);
  expect(f.fetch).toHaveBeenLastCalledWith('https://matrix.test/_matrix/client/v3/logout', expect.objectContaining({ method: 'POST', headers: { authorization: 'Bearer new-token' } }));
});
it('keeps temporary homeserver failure retryable without minting a device', async () => {
  const f = await fixture();
  f.fetch.mockResolvedValue(new Response('{}', { status: 503 }));
  expect((await f.handler(request())).status).toBe(503);
  expect(f.resume).not.toHaveBeenCalled();
});


it('rejects the superseded bearer after the resumed client logs out the old device', async () => {
  const f = await fixture();
  let loggedOut = false;
  f.fetch.mockImplementation(async (url, init) => {
    const token = new Headers(init?.headers).get('authorization');
    if (String(url).endsWith('/logout')) { loggedOut = true; return Response.json({}); }
    return loggedOut && token === 'Bearer old-token' ? new Response('{}', { status: 401 }) : Response.json({ user_id: old.userId });
  });
  const response = await f.handler(request());
  expect(response.status).toBe(200);
  const delivered = await response.json();
  expect(delivered).toEqual(fresh);
  await f.fetch('https://matrix.test/_matrix/client/v3/logout', { method: 'POST', headers: { authorization: 'Bearer old-token' } });
  f.resume.mockClear();
  expect((await f.handler(request())).status).toBe(401);
  expect(f.resume).not.toHaveBeenCalled();
  expect((await f.handler(request(fresh.accessToken))).status).toBe(200);
});
