import { describe, expect, it } from 'vitest';
import * as join from './agent-join';
import { decodeWith } from '../messaging/decode';

const request = { link: 'https://127.0.0.1:8443/join/inv_abcdefgh', harness: 'claude', label: 'Claude' };
const credentials = { homeserver: 'https://127.0.0.1:8443', userId: '@agent-abc:khala.local', accessToken: 'token', deviceId: 'KH_AGENT_12345678', roomId: '!v12room' };
const created = { joinId: 'a/b &?', pollSecret: 'secret', confirmUrl: 'https://app.example' + join.agentConfirmPagePath('a/b &?'), expiresAt: '2026-10-01T12:00:00Z' };
const view = { joinId: 'join', label: 'Claude', harness: 'claude', channelName: '', roomId: '!v12room', state: 'pending' };

describe('M1 agent join', () => {
  it('accepts wire shapes without changing values', () => {
    for (const [decode, value] of [[join.decodeAgentJoinRequest, request], [join.decodeAgentCredentials, credentials], [join.decodeAgentJoinCreated, created], [join.decodeAgentJoinView, view]] as const) {
      expect(decode(value)).toEqual({ ok: true, value });
    }
    expect(join.decodeAgentJoinView({ ...view, agentUserId: credentials.userId })).toEqual({ ok: true, value: { ...view, agentUserId: credentials.userId } });
  });
  it('rejects extra and missing fields on each wire shape', () => {
    for (const [decode, value] of [[join.decodeAgentJoinRequest, request], [join.decodeAgentCredentials, credentials], [join.decodeAgentJoinCreated, created], [join.decodeAgentJoinView, view], [join.decodeAgentJoinError, { error: 'not_found' }]] as const) {
      expect(decode({ ...value, extra: true })).toEqual({ ok: false, error: { path: 'extra', code: 'unknown_field' } });
      expect(decode({} ).ok).toBe(false);
    }
    expect(join.decodeAgentJoinView({ ...view, agentUserId: undefined })).toEqual({ ok: false, error: { path: 'agentUserId', code: 'wrong_type' } });
  });
  it.each([' Claude', 'Claude ', 'e\u0301', '', 'owner', 'System', 'a\n', 'a'.repeat(41), '界'.repeat(27)])('rejects changed or unsafe label %j', label => {
    expect(join.decodeAgentJoinRequest({ ...request, label })).toEqual({ ok: false, error: { path: 'label', code: 'invalid_value' } });
  });
  it('counts Unicode characters and enforces the existing byte cap', () => {
    for (const label of ['a'.repeat(40), 'é'.repeat(40), '😀'.repeat(20)]) expect(join.decodeAgentJoinRequest({ ...request, label }).ok).toBe(true);
    expect(join.decodeAgentJoinRequest({ ...request, label: 12 })).toEqual({ ok: false, error: { path: 'label', code: 'wrong_type' } });
  });
  it.each(['http://localhost', 'http://127.0.0.1:8080', 'http://[::1]:8080', 'https://app.example'])('allows approved link origins %s', origin => {
    expect(join.decodeAgentJoinRequest({ ...request, link: origin + '/join/abcdefgh' }).ok).toBe(true);
  });
  it.each(['http://app.example/join/abcdefgh', 'https://user:pass@app.example/join/abcdefgh', 'https://app.example/join/abcdefgh?q=1', 'https://app.example/join/abcdefgh#x', 'https://app.example/join/short', 'https://APP.example/join/abcdefgh', 'https://app.example:443/join/abcdefgh', 'https://app.example/join/' + 'a'.repeat(257), 'not a URL'])('rejects invalid channel link %s', link => {
    expect(join.decodeAgentJoinRequest({ ...request, link }).ok).toBe(false);
  });
  it('limits channel links by UTF-8 bytes', () => {
    const link = 'https://app.example/join/abcdefgh';
    expect(decodeWith(() => join.readChannelLink(link, 'link')).ok).toBe(true);
    expect(decodeWith(() => join.readChannelLink('https://' + 'a'.repeat(2048) + '.example/join/abcdefgh', 'link')).ok).toBe(false);
  });
  it.each(['/wrong?joinId=a', '/agent/confirm', '/agent/confirm?joinId=wrong', '/agent/confirm?joinId=a&joinId=a', '/agent/confirm?joinId=a&other=b', '/agent/confirm?joinId=a#hash'])('binds confirmation URL to the exact query %s', path => {
    expect(join.decodeAgentJoinCreated({ ...created, joinId: 'a', confirmUrl: 'https://app.example' + path })).toEqual({ ok: false, error: { path: 'confirmUrl', code: 'invalid_value' } });
  });
  it.each(['https://app.example/', 'https://app.example/path', 'https://app.example?x=1', 'http://remote.example', 'https://u:p@app.example'])('requires homeserver to be an allowed bare origin %s', homeserver => {
    expect(join.decodeAgentCredentials({ ...credentials, homeserver }).ok).toBe(false);
  });
  it('checks Matrix identifiers and calendar dates', () => {
    expect(join.decodeAgentCredentials({ ...credentials, userId: '@missing-server' }).ok).toBe(false);
    expect(join.decodeAgentCredentials({ ...credentials, roomId: '!room space' }).ok).toBe(false);
    expect(join.decodeAgentJoinCreated({ ...created, expiresAt: '2026-02-30T00:00:00Z' }).ok).toBe(false);
  });
  it('uses strict discriminated poll shapes with nested errors', () => {
    for (const state of ['pending', 'claimed', 'expired']) {
      expect(join.decodeAgentJoinPoll({ state })).toEqual({ ok: true, value: { state } });
      expect(join.decodeAgentJoinPoll({ state, credentials }).ok).toBe(false);
    }
    expect(join.decodeAgentJoinPoll({ state: 'confirmed', credentials })).toEqual({ ok: true, value: { state: 'confirmed', credentials } });
    expect(join.decodeAgentJoinPoll({ state: 'confirmed' })).toEqual({ ok: false, error: { path: 'credentials', code: 'missing_field' } });
    expect(join.decodeAgentJoinPoll({ state: 'confirmed', credentials: { ...credentials, roomId: 'bad' } })).toEqual({ ok: false, error: { path: 'credentials.roomId', code: 'invalid_value' } });
    expect(join.decodeAgentJoinPoll(null).ok).toBe(false);
    expect(join.decodeAgentJoinPoll({ state: 'ready' }).ok).toBe(false);
  });
  it('exports every exact route with encoded query parameters', () => {
    expect(join.AGENT_JOIN_PATH).toBe('/api/agent/join');
    for (const [helper, path] of [[join.agentJoinPollPath, '/api/agent/join/poll'], [join.agentJoinReadyPath, '/api/agent/join/ready'], [join.humanAgentJoinPath, '/api/human/agent-join'], [join.humanAgentJoinConfirmPath, '/api/human/agent-join/confirm'], [join.humanAgentJoinStatusPath, '/api/human/agent-join/status'], [join.agentConfirmPagePath, '/agent/confirm']] as const) expect(helper('a/b &?')).toBe(path + '?joinId=a%2Fb%20%26%3F');
  });
  it('decodes all ten API error codes and maps request error paths', () => {
    for (const error of ['invalid_link', 'invalid_label', 'invalid_harness', 'link_unavailable', 'rate_limited', 'not_found', 'not_confirmed', 'signed_out', 'not_member', 'already_confirmed_by_other']) expect(join.decodeAgentJoinError({ error })).toEqual({ ok: true, value: { error } });
    expect(join.decodeAgentJoinError({ error: 'forbidden_origin' }).ok).toBe(false);
    expect(join.decodeAgentJoinRequest({ ...request, harness: 'other' }).ok).toBe(false);
    for (const [path, expected] of [['label', 'invalid_label'], ['label.nested', 'invalid_label'], ['harness', 'invalid_harness'], ['', 'invalid_link'], ['extra', 'invalid_link']]) expect(join.agentJoinRequestErrorCode({ path: path!, code: 'invalid_value' })).toBe(expected);
  });
});

describe('local join additions', () => {
  it('preserves hosted records without adding optional fields', () => {
    expect(join.decodeAgentJoinCreated(created)).toEqual({ ok: true, value: created });
    expect(join.decodeAgentCredentials(credentials)).toEqual({ ok: true, value: credentials });
  });
  it('accepts exact optional values, including nested local credentials', () => {
    const auto = { ...created, autoConfirmed: true };
    expect(join.decodeAgentJoinCreated(auto)).toEqual({ ok: true, value: auto });
    for (const transport of ['local', 'matrix']) {
      const value = { ...credentials, transport };
      expect(join.decodeAgentCredentials(value)).toEqual({ ok: true, value });
      expect(join.decodeAgentJoinPoll({ state: 'confirmed', credentials: value })).toEqual({ ok: true, value: { state: 'confirmed', credentials: value } });
    }
    const local = { homeserver: 'http://127.0.0.1:47830', userId: '@agent-a1b2c3d4:local', accessToken: 'a'.repeat(43), deviceId: 'KH_LOCAL_a1b2c3d4', roomId: '!AAAAAAAAAAAAAAAAAAAAAA:local', transport: 'local' };
    expect(join.decodeAgentCredentials(local)).toEqual({ ok: true, value: local });
  });
  it.each([false, 'true', 1, undefined, null])('rejects autoConfirmed %j', autoConfirmed => {
    expect(join.decodeAgentJoinCreated({ ...created, autoConfirmed })).toEqual({ ok: false, error: { path: 'autoConfirmed', code: 'invalid_value' } });
  });
  it.each(['tcp', '', undefined, null, 1])('rejects transport %j at the correct path', transport => {
    const code = typeof transport === 'string' ? 'invalid_value' : 'wrong_type';
    expect(join.decodeAgentCredentials({ ...credentials, transport })).toEqual({ ok: false, error: { path: 'transport', code } });
    expect(join.decodeAgentJoinPoll({ state: 'confirmed', credentials: { ...credentials, transport } })).toEqual({ ok: false, error: { path: 'credentials.transport', code } });
  });
});

it('accepts optional stable session identity and rejects malformed identities', () => {
  const value = { ...request, sessionId: 'thread-019a_1' };
  expect(join.decodeAgentJoinRequest(value)).toEqual({ ok: true, value });
  for (const sessionId of ['', '../thread', 'a'.repeat(129), null, 42, undefined]) {
    expect(join.decodeAgentJoinRequest({ ...request, sessionId }).ok).toBe(false);
  }
});
