import { createHash, createHmac } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { OwnerId } from '@khala/contracts/messaging/index';
import { agentIdentity, createAgentProvisioner } from './provision';
const input = { joinId: 'abcdefghijklmnopqrstuv', ownerId: 'owner' as OwnerId, ownerEmail: 'maya99@x', label: 'Claude', roomId: '!room:matrix.test' };
const options = { homeserverOrigin: 'https://matrix.test', serverName: 'matrix.test', registrationSharedSecret: 'register', registrationIngressToken: 'ingress', passwordDerivationSecret: 'password', joinSecret: 'join' };
it('derives the contract identity deterministically per join', () => {
  const id = agentIdentity(input.joinId, input.ownerId, options.serverName, options.joinSecret);
  const rand = [...createHmac('sha256', 'join').update(`khala-agent-join-rand-v1\0${input.joinId}`).digest().subarray(0, 6)].map(b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
  expect(id.username).toBe(`agent-${createHash('sha256').update('owner').digest('hex').slice(0, 8)}-${rand}`);
  expect(id.userId).toBe(`@${id.username}:matrix.test`);
  expect(id.deviceId).toBe(`KH_AGENT_${createHmac('sha256', 'join').update(`khala-agent-join-device-v1\0${input.joinId}`).digest('hex').slice(0, 8)}`);
  expect(agentIdentity(input.joinId, input.ownerId, 'matrix.test', 'join')).toEqual(id);
  expect(agentIdentity('other', input.ownerId, 'matrix.test', 'join')).not.toEqual(id);
});
it.each([false, true])('registers with a display name and logs in, existing=%s', async existing => {
  const id = agentIdentity(input.joinId, input.ownerId, 'matrix.test', 'join');
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json({ nonce: 'nonce' })).mockResolvedValueOnce(existing ? Response.json({ errcode: 'M_USER_IN_USE' }, { status: 400 }) : Response.json({ user_id: id.userId })).mockResolvedValueOnce(Response.json({ user_id: id.userId, device_id: id.deviceId, access_token: 'token' }));
  expect(await createAgentProvisioner({ ...options, fetch }).provision(input)).toEqual({ kind: 'ok', credentials: { homeserver: options.homeserverOrigin, userId: id.userId, deviceId: id.deviceId, accessToken: 'token', roomId: input.roomId } });
  const registration = JSON.parse(fetch.mock.calls[1]![1]!.body as string);
  const password = createHmac('sha256', 'password').update(`khala-agent-password-v1\0${id.userId}`).digest('base64url');
  expect(registration).toEqual({ nonce: 'nonce', username: id.username, password, admin: false, displayname: 'Claude · Maya', mac: createHmac('sha1', 'register').update(`nonce\0${id.username}\0${password}\0notadmin`).digest('hex') });
  expect(JSON.parse(fetch.mock.calls[2]![1]!.body as string)).toMatchObject({ identifier: { user: id.userId }, device_id: id.deviceId, password });
  for (const call of fetch.mock.calls) expect(call[1]!.signal).toBeInstanceOf(AbortSignal);
  expect(new Headers(fetch.mock.calls[0]![1]!.headers).get('X-Khala-Registration-Ingress')).toBe('ingress');
});
it.each(['nonce', 'registration', 'login', 'user', 'device', 'token', 'throw', 'json'])('fails closed on %s failures', async failure => {
  const id = agentIdentity(input.joinId, input.ownerId, 'matrix.test', 'join');
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(failure === 'json' ? new Response('{') : Response.json(failure === 'nonce' ? {} : { nonce: 'nonce' })).mockResolvedValueOnce(Response.json({ user_id: id.userId }, { status: failure === 'registration' ? 500 : 200 })).mockResolvedValueOnce(Response.json({ user_id: failure === 'user' ? '@other:matrix.test' : id.userId, device_id: failure === 'device' ? 'other' : id.deviceId, access_token: failure === 'token' ? 42 : 'token' }, { status: failure === 'login' ? 503 : 200 }));
  if (failure === 'throw') fetch.mockReset().mockRejectedValue(Error('offline'));
  expect(await createAgentProvisioner({ ...options, fetch }).provision(input)).toEqual({ kind: 'unavailable' });
});
