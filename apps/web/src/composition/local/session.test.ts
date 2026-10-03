import { describe, expect, it, vi } from 'vitest';
import type { OwnerId } from '@khala/contracts/messaging/ids';
import { createLocalHttp } from './http';
import { createLocalSession, LOCAL_PRINCIPAL } from './session';
const profile = { userId: '@khala_owner:local', ownerId: 'local-owner', username: 'kevin', suggestion: 'kevin', color: 'teal', initials: null };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const setup = () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  return { fetch, session: createLocalSession(createLocalHttp({ origin: 'http://127.0.0.1:47830', fetch })) };
};
describe('local session', () => {
  it('signs in only when the helper answers and never signs out on failures', async () => {
    const { fetch, session } = setup();
    fetch.mockResolvedValueOnce(json(200, profile)).mockResolvedValueOnce(json(401, { error: 'unauthorized' })).mockResolvedValueOnce(json(500, {})).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(json(200, { ...profile, initials: undefined }));
    expect(await session.identity.current()).toEqual({ kind: 'signed_in', principal: LOCAL_PRINCIPAL });
    for (let i = 0; i < 4; i++) expect(await session.identity.current()).toEqual({ kind: 'unavailable', retryable: true });
    expect(LOCAL_PRINCIPAL).toEqual({ v: 1, ownerId: 'local-owner', providerIssuer: 'khala-local', providerSubject: 'owner', verifiedEmail: '', sessionExpiresAt: '9999-12-31T23:59:59.000Z' });
  });
  it('caches participant identity until a valid username changes', async () => {
    const { fetch, session } = setup();
    expect(session.participant()).toBeNull();
    fetch.mockResolvedValue(json(200, profile));
    await session.identity.current();
    const participant = session.participant();
    expect(participant).toEqual({ participantId: '@khala_owner:local', kind: 'human', ownerId: 'local-owner', displayName: 'kevin', deviceIds: ['KH_LOCAL_OWNER'] });
    expect(session.participant()).toBe(participant);
    await session.identity.current();
    expect(session.participant()).toBe(participant);
    session.noteUsername(' bad name ');
    expect(session.participant()).toBe(participant);
    session.noteUsername('kev');
    expect(session.participant()?.displayName).toBe('kev');
    expect(session.participant()).not.toBe(participant);
  });
  it('keeps generation one throughout device lifecycle and isolates observers', async () => {
    const { session } = setup();
    const fresh = { deviceId: null, state: 'new', generation: 1, reason: null };
    const ready = { deviceId: 'KH_LOCAL_OWNER', state: 'ready', generation: 1, reason: null };
    expect(session.device.current()).toEqual(fresh);
    session.device.observe(() => { throw new Error('observer'); });
    const observer = vi.fn();
    const dispose = session.device.observe(observer);
    expect(await session.device.ensureReady('local-owner' as OwnerId)).toEqual({ kind: 'ok', value: ready });
    await session.device.ensureReady('local-owner' as OwnerId);
    expect(observer).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenLastCalledWith(ready);
    await session.device.stop();
    expect(observer).toHaveBeenLastCalledWith(fresh);
    expect(session.device.current()).toEqual(fresh);
    expect(await session.device.ensureReady('someone-else' as OwnerId)).toEqual({ kind: 'rejected', code: 'owner_mismatch' });
    expect(await session.device.ensureReady('local-owner' as OwnerId, { signal: AbortSignal.abort() })).toEqual({ kind: 'unavailable', retryable: true });
    dispose(); dispose();
    await session.device.ensureReady('local-owner' as OwnerId);
    expect(observer).toHaveBeenCalledTimes(2);
  });
  it('does not fetch for sign-in or sign-out actions', async () => {
    const { fetch, session } = setup();
    expect(await session.identity.beginSignIn('/conversations')).toEqual({ kind: 'rejected', code: 'invalid_return_path' });
    expect(await session.identity.signOut('op1')).toEqual({ kind: 'unavailable', retryable: true });
    expect(fetch).not.toHaveBeenCalled();
  });
});
