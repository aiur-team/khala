import { describe, expect, it, vi } from 'vitest';
import { createLocalHttp } from './http';
import { createLocalProfilePort } from './profile';
const origin = 'http://127.0.0.1:47830';
const view = { userId: '@khala_owner:local', ownerId: 'local-owner', username: 'kevin', suggestion: 'kevin', color: 'teal', initials: null };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const setup = () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const onUsername = vi.fn();
  return { fetch, onUsername, profile: createLocalProfilePort(createLocalHttp({ origin, fetch }), { onUsername }) };
};
describe('local profile', () => {
  it.each([
    [200, view, { kind: 'ok', username: 'kevin', suggestion: 'kevin', color: 'teal', initials: null }],
    [200, { ...view, initials: 'KW' }, { kind: 'ok', username: 'kevin', suggestion: 'kevin', color: 'teal', initials: 'KW' }],
    [200, { ...view, initials: 'kw' }, { kind: 'ok', username: 'kevin', suggestion: 'kevin', color: 'teal', initials: null }],
    [401, {}, { kind: 'error', code: 'signed_out' }],
    [503, {}, { kind: 'error', code: 'unavailable' }],
    [200, { ...view, extra: true }, { kind: 'error', code: 'unavailable' }],
    [200, { ...view, initials: undefined }, { kind: 'error', code: 'unavailable' }],
  ])('maps profile response %s %j', async (status, body, expected) => {
    const { fetch, profile } = setup(); fetch.mockResolvedValue(json(status, body));
    expect(await profile.get()).toEqual(expected);
  });
  it('saves usernames through the guarded endpoint and updates the session', async () => {
    const { fetch, profile, onUsername } = setup(); fetch.mockResolvedValue(json(200, { username: 'kev' }));
    expect(await profile.setUsername('kev')).toEqual({ kind: 'ok', username: 'kev' });
    expect(onUsername).toHaveBeenCalledExactlyOnceWith('kev');
    expect(fetch).toHaveBeenCalledWith(`${origin}/api/local/profile/username`, expect.objectContaining({ method: 'POST', body: '{"username":"kev"}', headers: expect.objectContaining({ 'x-khala-local': '1' }) }));
  });
  it.each([
    [200, { username: 'admin' }, { kind: 'error', code: 'unavailable' }],
    [200, { username: 'kev', extra: true }, { kind: 'error', code: 'unavailable' }],
    [400, { error: 'invalid_username', reason: 'too_short' }, { kind: 'error', code: 'invalid_username', reason: 'too_short' }],
    [400, { error: 'invalid_username', reason: 'invented' }, { kind: 'error', code: 'invalid_username' }],
    [409, {}, { kind: 'error', code: 'username_taken' }],
    [401, {}, { kind: 'error', code: 'signed_out' }],
    [403, { error: 'forbidden_origin' }, { kind: 'error', code: 'unavailable' }],
  ])('maps username response %s %j', async (status, body, expected) => {
    const { fetch, profile, onUsername } = setup(); fetch.mockResolvedValue(json(status, body));
    expect(await profile.setUsername('kev')).toEqual(expected); expect(onUsername).not.toHaveBeenCalled();
  });
  it.each([
    [200, { color: 'pink' }, { kind: 'ok', color: 'pink' }],
    [400, {}, { kind: 'error', code: 'invalid_color' }],
    [401, {}, { kind: 'error', code: 'signed_out' }],
    [503, {}, { kind: 'error', code: 'unavailable' }],
    [200, { color: 'chartreuse' }, { kind: 'error', code: 'unavailable' }],
    [200, { color: 'pink', extra: true }, { kind: 'error', code: 'unavailable' }],
  ])('maps color response %s %j', async (status, body, expected) => {
    const { fetch, profile } = setup(); fetch.mockResolvedValue(json(status, body));
    expect(await profile.setColor('pink')).toEqual(expected);
    expect(fetch).toHaveBeenCalledWith(`${origin}/api/local/profile/color`, expect.objectContaining({ body: '{"color":"pink"}' }));
  });
  it.each([
    [200, { initials: 'KW' }, { kind: 'ok', initials: 'KW' }],
    [200, { initials: null }, { kind: 'ok', initials: null }],
    [400, {}, { kind: 'error', code: 'invalid_initials' }],
    [401, {}, { kind: 'error', code: 'signed_out' }],
    [503, {}, { kind: 'error', code: 'unavailable' }],
    [200, { initials: 'kw' }, { kind: 'error', code: 'unavailable' }],
    [200, { initials: 'KW', extra: true }, { kind: 'error', code: 'unavailable' }],
  ])('maps initials response %s %j', async (status, body, expected) => {
    const { fetch, profile } = setup(); fetch.mockResolvedValue(json(status, body));
    const initials = 'initials' in body && body.initials === null ? null : 'KW';
    expect(await profile.setInitials(initials)).toEqual(expected);
    expect(fetch).toHaveBeenCalledWith(`${origin}/api/local/profile/initials`, expect.objectContaining({ body: JSON.stringify({ initials }) }));
  });
  it('maps network failures for every method', async () => {
    const { fetch, profile } = setup(); fetch.mockRejectedValue(new Error('offline'));
    for (const result of await Promise.all([profile.get(), profile.setUsername('kev'), profile.setColor('pink'), profile.setInitials(null)])) expect(result).toEqual({ kind: 'error', code: 'unavailable' });
  });
});
