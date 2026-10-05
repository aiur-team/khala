import { createHash, createHmac } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { OwnerId } from '@khala/contracts/messaging/index';
import { agentIdentity, createAgentProvisioner } from './provision';
const input = { joinId: 'abcdefghijklmnopqrstuv', ownerId: 'owner' as OwnerId, label: 'Maya-Claude', roomId: '!room:matrix.test' };
const options = { homeserverOrigin: 'https://matrix.test', serverName: 'matrix.test', registrationSharedSecret: 'register', registrationIngressToken: 'ingress', passwordDerivationSecret: 'password', joinSecret: 'join' };
it('derives the contract identity deterministically per join', () => {
  const id = agentIdentity(input.joinId, input.ownerId, options.serverName, options.joinSecret);
  const rand = [...createHmac('sha256', 'join').update(`khala-agent-join-rand-v1\0${input.joinId}`).digest().subarray(0, 6)].map(b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
  expect(id.username).toBe(`agent-${createHash('sha256').update('owner').digest('hex').slice(0, 8)}-${rand}`);
  expect(id.userId).toBe(`@${id.username}:matrix.test`);
  expect(id.deviceId).toBe(`KH_AGENT_${createHmac('sha256', 'join').update(`khala-agent-join-device-v1\0${input.joinId}`).digest('hex').slice(0, 8)}`);
  expect(agentIdentity(input.joinId, input.ownerId, 'matrix.test', 'join')).toEqual(id);
  expect(createAgentProvisioner(options).agentUserId(input.joinId, input.ownerId)).toBe(id.userId);
  expect(agentIdentity('other', input.ownerId, 'matrix.test', 'join')).not.toEqual(id);
});
it.each([false, true])('registers with a display name and logs in, existing=%s', async existing => {
  const id = agentIdentity(input.joinId, input.ownerId, 'matrix.test', 'join');
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json({ nonce: 'nonce' })).mockResolvedValueOnce(existing ? Response.json({ errcode: 'M_USER_IN_USE' }, { status: 400 }) : Response.json({ user_id: id.userId })).mockResolvedValueOnce(Response.json({ user_id: id.userId, device_id: id.deviceId, access_token: 'token' })).mockResolvedValueOnce(Response.json({}));
  expect(await createAgentProvisioner({ ...options, fetch }).provision(input)).toEqual({ kind: 'ok', credentials: { homeserver: options.homeserverOrigin, userId: id.userId, deviceId: id.deviceId, accessToken: 'token', roomId: input.roomId } });
  const registration = JSON.parse(fetch.mock.calls[1]![1]!.body as string);
  const password = createHmac('sha256', 'password').update(`khala-agent-password-v1\0${id.userId}`).digest('base64url');
  expect(registration).toEqual({ nonce: 'nonce', username: id.username, password, admin: false, displayname: 'Maya-Claude', mac: createHmac('sha1', 'register').update(`nonce\0${id.username}\0${password}\0notadmin`).digest('hex') });
  expect(JSON.parse(fetch.mock.calls[2]![1]!.body as string)).toMatchObject({ identifier: { user: id.userId }, device_id: id.deviceId, password });
  expect(fetch.mock.calls[3]![0]).toBe(`https://matrix.test/_matrix/client/v3/profile/${encodeURIComponent(id.userId)}/displayname`);
  expect(fetch.mock.calls[3]![1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ displayname: input.label }) });
  expect(new Headers(fetch.mock.calls[3]![1]!.headers).get('authorization')).toBe('Bearer token');
  for (const call of fetch.mock.calls) expect(call[1]!.signal).toBeInstanceOf(AbortSignal);
  expect(new Headers(fetch.mock.calls[0]![1]!.headers).get('X-Khala-Registration-Ingress')).toBe('ingress');
});
it.each(['nonce', 'registration', 'login', 'user', 'device', 'token', 'throw', 'json'])('fails closed on %s failures', async failure => {
  const id = agentIdentity(input.joinId, input.ownerId, 'matrix.test', 'join');
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(failure === 'json' ? new Response('{') : Response.json(failure === 'nonce' ? {} : { nonce: 'nonce' })).mockResolvedValueOnce(Response.json({ user_id: id.userId }, { status: failure === 'registration' ? 500 : 200 })).mockResolvedValueOnce(Response.json({ user_id: failure === 'user' ? '@other:matrix.test' : id.userId, device_id: failure === 'device' ? 'other' : id.deviceId, access_token: failure === 'token' ? 42 : 'token' }, { status: failure === 'login' ? 503 : 200 }));
  if (failure === 'throw') fetch.mockReset().mockRejectedValue(Error('offline'));
  expect(await createAgentProvisioner({ ...options, fetch }).provision(input)).toEqual({ kind: 'unavailable' });
});

it.each(['status', 'throw'])('keeps provisioning successful when the display name repair fails: %s', async failure => {
  const id = agentIdentity(input.joinId, input.ownerId, 'matrix.test', 'join');
  const fetch = vi.fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ nonce: 'nonce' }))
    .mockResolvedValueOnce(Response.json({ errcode: 'M_USER_IN_USE' }, { status: 400 }))
    .mockResolvedValueOnce(Response.json({ user_id: id.userId, device_id: id.deviceId, access_token: 'token' }));
  if (failure === 'throw') fetch.mockRejectedValueOnce(Error('offline'));
  else fetch.mockResolvedValueOnce(new Response(null, { status: 500 }));
  expect(await createAgentProvisioner({ ...options, fetch }).provision(input)).toMatchObject({ kind: 'ok' });
  expect(fetch).toHaveBeenCalledTimes(4);
});

it('renames globally using a dedicated control device and logs out that token', async () => {
  const userId = '@agent:matrix.test';
  const deviceId = `KH_AGENT_CTL_${createHmac('sha256', 'join').update(`khala-agent-ctl-device-v1\0${userId}`).digest('hex').slice(0, 8)}`;
  const fetch = vi.fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ user_id: userId, device_id: deviceId, access_token: 'control-token' }))
    .mockResolvedValueOnce(Response.json({})).mockResolvedValueOnce(Response.json({}));
  expect(await createAgentProvisioner({ ...options, fetch }).setDisplayName(userId, 'Reviewer')).toBe(true);
  expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({ type: 'm.login.password',
    identifier: { type: 'm.id.user', user: userId },
    password: createHmac('sha256', 'password').update(`khala-agent-password-v1\0${userId}`).digest('base64url'),
    device_id: deviceId, initial_device_display_name: 'Khala agent control' });
  expect(fetch.mock.calls[1]).toEqual([`https://matrix.test/_matrix/client/v3/profile/${encodeURIComponent(userId)}/displayname`,
    expect.objectContaining({ method: 'PUT', body: JSON.stringify({ displayname: 'Reviewer' }), headers: {
      authorization: 'Bearer control-token', 'content-type': 'application/json' } })]);
  expect(fetch.mock.calls[2]).toEqual(['https://matrix.test/_matrix/client/v3/logout',
    expect.objectContaining({ method: 'POST', headers: { authorization: 'Bearer control-token' } })]);
});
it.each(['put_status', 'put_throw', 'logout_throw', 'wrong_user', 'wrong_device', 'login_status', 'login_json', 'no_token'])('handles display-name failure and token cleanup: %s', async failure => {
  const userId = '@agent:matrix.test';
  const deviceId = `KH_AGENT_CTL_${createHmac('sha256', 'join').update(`khala-agent-ctl-device-v1\0${userId}`).digest('hex').slice(0, 8)}`;
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(failure === 'login_json' ? new Response('{') : Response.json({
    user_id: failure === 'wrong_user' ? '@other:matrix.test' : userId,
    device_id: failure === 'wrong_device' ? 'KH_AGENT_LIVE' : deviceId,
    access_token: failure === 'no_token' ? '' : 'token',
  }, { status: failure === 'login_status' ? 503 : 200 }));
  if (failure === 'put_throw') fetch.mockRejectedValueOnce(Error('offline'));
  else fetch.mockResolvedValueOnce(Response.json({}, { status: failure === 'put_status' ? 500 : 200 }));
  if (failure === 'logout_throw') fetch.mockRejectedValueOnce(Error('offline'));
  else fetch.mockResolvedValueOnce(Response.json({}));
  expect(await createAgentProvisioner({ ...options, fetch }).setDisplayName(userId, 'Reviewer')).toBe(failure === 'logout_throw');
  if (['put_status', 'put_throw', 'logout_throw', 'wrong_user', 'wrong_device'].includes(failure)) {
    expect(fetch.mock.calls.at(-1)![0]).toBe('https://matrix.test/_matrix/client/v3/logout');
  }
});

it('reuses the account identity but issues a fresh device for each join', async () => {
  const identityId = 'session.thread-1';
  const id = agentIdentity(identityId, input.ownerId, 'matrix.test', 'join');
  const devices: string[] = [];
  for (const joinId of ['first-join', 'second-join']) {
    const deviceId = agentIdentity(joinId, input.ownerId, 'matrix.test', 'join').deviceId;
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ nonce: 'nonce' }))
      .mockResolvedValueOnce(Response.json({ errcode: 'M_USER_IN_USE' }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ user_id: id.userId, device_id: deviceId, access_token: 'token' }))
      .mockResolvedValueOnce(Response.json({}));
    const result = await createAgentProvisioner({ ...options, fetch }).provision({ ...input, identityId, joinId });
    expect(result).toMatchObject({ kind: 'ok', credentials: { userId: id.userId, deviceId } });
    devices.push(deviceId);
  }
  expect(devices[0]).not.toBe(devices[1]);
});


it('mints a distinct crypto device on every authorized resume without changing identity', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    return Response.json({ user_id: body.identifier.user, device_id: body.device_id, access_token: 'fresh-token' });
  });
  const provisioner = createAgentProvisioner({ ...options, fetch });
  const input = { userId: '@agent:matrix.test', roomId: '!room:matrix.test' };
  const first = await provisioner.resume!(input);
  const second = await provisioner.resume!(input);
  expect(first.kind).toBe('ok'); expect(second.kind).toBe('ok');
  if (first.kind !== 'ok' || second.kind !== 'ok') throw new Error('resume');
  expect(first.credentials.userId).toBe(input.userId);
  expect(first.credentials.roomId).toBe(input.roomId);
  expect(first.credentials.deviceId).not.toBe(second.credentials.deviceId);
  expect(fetch.mock.calls.map(call => String(call[0]))).toEqual(['https://matrix.test/_matrix/client/v3/login', 'https://matrix.test/_matrix/client/v3/login']);
});
