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
it.each([false, true])('registers with a name and logs in without profile updates, existing=%s', async existing => {
  const id = agentIdentity(input.joinId, input.ownerId, 'matrix.test', 'join');
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json({ nonce: 'nonce' })).mockResolvedValueOnce(existing ? Response.json({ errcode: 'M_USER_IN_USE' }, { status: 400 }) : Response.json({ user_id: id.userId })).mockResolvedValueOnce(Response.json({ user_id: id.userId, device_id: id.deviceId, access_token: 'token' }));
  expect(await createAgentProvisioner({ ...options, fetch }).provision(input)).toEqual({ kind: 'ok', credentials: { homeserver: options.homeserverOrigin, userId: id.userId, deviceId: id.deviceId, accessToken: 'token', roomId: input.roomId } });
  const registration = JSON.parse(fetch.mock.calls[1]![1]!.body as string);
  const password = createHmac('sha256', 'password').update(`khala-agent-password-v1\0${id.userId}`).digest('base64url');
  expect(registration).toEqual({ nonce: 'nonce', username: id.username, password, admin: false, displayname: 'Maya-Claude', mac: createHmac('sha1', 'register').update(`nonce\0${id.username}\0${password}\0notadmin`).digest('hex') });
  expect(JSON.parse(fetch.mock.calls[2]![1]!.body as string)).toMatchObject({ identifier: { user: id.userId }, device_id: id.deviceId, password });
  expect(fetch).toHaveBeenCalledTimes(3);
  for (const call of fetch.mock.calls) expect(call[1]!.signal).toBeInstanceOf(AbortSignal);
  expect(new Headers(fetch.mock.calls[0]![1]!.headers).get('X-Khala-Registration-Ingress')).toBe('ingress');
});
it.each(['nonce', 'registration', 'login', 'user', 'device', 'token', 'throw', 'json'])('fails closed on %s failures', async failure => {
  const id = agentIdentity(input.joinId, input.ownerId, 'matrix.test', 'join');
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(failure === 'json' ? new Response('{') : Response.json(failure === 'nonce' ? {} : { nonce: 'nonce' })).mockResolvedValueOnce(Response.json({ user_id: id.userId }, { status: failure === 'registration' ? 500 : 200 })).mockResolvedValueOnce(Response.json({ user_id: failure === 'user' ? '@other:matrix.test' : id.userId, device_id: failure === 'device' ? 'other' : id.deviceId, access_token: failure === 'token' ? 42 : 'token' }, { status: failure === 'login' ? 503 : 200 }));
  if (failure === 'throw') fetch.mockReset().mockRejectedValue(Error('offline'));
  expect(await createAgentProvisioner({ ...options, fetch }).provision(input)).toEqual({ kind: 'unavailable' });
});

it('renames each joined membership without erasing room state and logs out the control token', async () => {
  const userId = '@agent:matrix.test';
  const deviceId = `KH_AGENT_CTL_${createHmac('sha256', 'join').update(`khala-agent-ctl-device-v1\0${userId}`).digest('hex').slice(0, 8)}`;
  const fetch = vi.fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ user_id: userId, device_id: deviceId, access_token: 'control-token' }))
    .mockResolvedValueOnce(Response.json({ joined_rooms: ['!room:matrix.test', '!second:matrix.test'] }))
    .mockResolvedValueOnce(Response.json({ membership: 'join', displayname: 'Old', 'com.khala.invited_by': '@owner:matrix.test', 'com.khala.listening_mode': 'steer', avatar_url: 'mxc://avatar' }))
    .mockResolvedValueOnce(Response.json({}))
    .mockResolvedValueOnce(Response.json({ membership: 'join', 'com.khala.listening_mode': 'async' }))
    .mockResolvedValueOnce(Response.json({})).mockResolvedValueOnce(Response.json({}));
  expect(await createAgentProvisioner({ ...options, fetch }).setDisplayName(userId, 'Reviewer')).toBe(true);
  expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({ type: 'm.login.password',
    identifier: { type: 'm.id.user', user: userId },
    password: createHmac('sha256', 'password').update(`khala-agent-password-v1\0${userId}`).digest('base64url'),
    device_id: deviceId, initial_device_display_name: 'Khala agent control' });
  const memberPath = (room: string) => `https://matrix.test/_matrix/client/v3/rooms/${encodeURIComponent(room)}/state/m.room.member/${encodeURIComponent(userId)}`;
  expect(fetch.mock.calls[1]![0]).toBe('https://matrix.test/_matrix/client/v3/joined_rooms');
  expect(fetch.mock.calls[2]![0]).toBe(memberPath('!room:matrix.test'));
  expect(fetch.mock.calls[3]).toEqual([memberPath('!room:matrix.test'), expect.objectContaining({ method: 'PUT',
    body: JSON.stringify({ membership: 'join', displayname: 'Reviewer', 'com.khala.invited_by': '@owner:matrix.test', 'com.khala.listening_mode': 'steer', avatar_url: 'mxc://avatar' }) })]);
  expect(fetch.mock.calls[5]).toEqual([memberPath('!second:matrix.test'), expect.objectContaining({ method: 'PUT',
    body: JSON.stringify({ membership: 'join', 'com.khala.listening_mode': 'async', displayname: 'Reviewer' }) })]);
  expect(fetch.mock.calls.some(([url]) => String(url).includes('/profile/'))).toBe(false);
  expect(fetch.mock.calls.at(-1)).toEqual(['https://matrix.test/_matrix/client/v3/logout',
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
  fetch.mockResolvedValueOnce(Response.json({ joined_rooms: ['!room:matrix.test'] }));
  fetch.mockResolvedValueOnce(Response.json({ membership: 'join', 'com.khala.listening_mode': 'steer' }));
  if (failure === 'put_throw') fetch.mockRejectedValueOnce(Error('offline'));
  else fetch.mockResolvedValueOnce(Response.json({}, { status: failure === 'put_status' ? 500 : 200 }));
  if (failure === 'logout_throw') fetch.mockRejectedValueOnce(Error('offline'));
  else fetch.mockResolvedValueOnce(Response.json({}));
  expect(await createAgentProvisioner({ ...options, fetch }).setDisplayName(userId, 'Reviewer')).toBe(failure === 'logout_throw');
  if (['put_status', 'put_throw', 'logout_throw', 'wrong_user', 'wrong_device'].includes(failure)) {
    expect(fetch.mock.calls.at(-1)![0]).toBe('https://matrix.test/_matrix/client/v3/logout');
  }
});

it.each(['rooms_status', 'rooms_json', 'rooms_missing', 'rooms_invalid', 'member_status', 'member_json', 'member_null', 'member_array', 'member_left'])('does not overwrite unreadable membership: %s', async failure => {
  const userId = '@agent:matrix.test';
  const deviceId = `KH_AGENT_CTL_${createHmac('sha256', 'join').update(`khala-agent-ctl-device-v1\0${userId}`).digest('hex').slice(0, 8)}`;
  const rooms = failure === 'rooms_missing' ? {} : { joined_rooms: failure === 'rooms_invalid' ? [42] : ['!room:matrix.test'] };
  const member = failure === 'member_null' ? null : failure === 'member_array' ? [] : { membership: failure === 'member_left' ? 'leave' : 'join' };
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    if (String(url).endsWith('/login')) return Response.json({ user_id: userId, device_id: deviceId, access_token: 'token' });
    if (String(url).endsWith('/logout')) return Response.json({});
    if (String(url).endsWith('/joined_rooms')) return failure === 'rooms_json' ? new Response('{') : Response.json(rooms, { status: failure === 'rooms_status' ? 503 : 200 });
    if (init?.method === 'PUT') throw new Error('Must not overwrite unreadable state');
    return failure === 'member_json' ? new Response('{') : Response.json(member, { status: failure === 'member_status' ? 503 : 200 });
  });
  expect(await createAgentProvisioner({ ...options, fetch }).setDisplayName(userId, 'Reviewer')).toBe(false);
  expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  expect(fetch.mock.calls.at(-1)![0]).toBe('https://matrix.test/_matrix/client/v3/logout');
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
      .mockResolvedValueOnce(Response.json({ user_id: id.userId, device_id: deviceId, access_token: 'token' }));
    const result = await createAgentProvisioner({ ...options, fetch }).provision({ ...input, identityId, joinId });
    expect(result).toMatchObject({ kind: 'ok', credentials: { userId: id.userId, deviceId } });
    expect(fetch).toHaveBeenCalledTimes(3);
    devices.push(deviceId);
  }
  expect(devices[0]).not.toBe(devices[1]);
});
