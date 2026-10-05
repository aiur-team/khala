import { humanInitialsRecordKey } from '@khala/contracts/m1/initials';
import { randomBytes } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { defaultHumanColor, humanColorRecordKey } from '@khala/contracts/m1/colors';
import { nameKey } from '@khala/contracts/m1/names';
import { profileRecordKey } from '@khala/contracts/m1/profile';
import type { AuthPrincipal, OwnerId } from '@khala/contracts/messaging/index';
import type { Authentication, MutationAuthorization } from '../auth/index';
import { createControlStore, type BlobsStoreLike } from '../runtime/control-store';
import { createProfileHandlers } from './routes';

function durableStores() {
  const namespaces = new Map<string, Map<string, { data: unknown; etag: string }>>();
  let revision = 0;
  const storeFor = (name: string): BlobsStoreLike => {
    let records = namespaces.get(name);
    if (!records) { records = new Map(); namespaces.set(name, records); }
    const backing = records;
    return {
      async getWithMetadata(key) { return backing.get(key) ?? null; },
      async setJSON(key, data, options) {
        const current = backing.get(key);
        if (options?.onlyIfNew && current) return { modified: false, etag: current.etag };
        if (options?.onlyIfMatch && current?.etag !== options.onlyIfMatch) return { modified: false, ...(current ? { etag: current.etag } : {}) };
        const etag = String(++revision);
        backing.set(key, { data: structuredClone(data), etag });
        return { modified: true, etag };
      },
    };
  };
  return { storeFor };
}
function fixture() {
  const clock = () => Date.parse('2026-10-02T18:00:00.000Z');
  const blobs = durableStores();
  const store = createControlStore({ records: blobs.storeFor('records'), operations: blobs.storeFor('operations'), clock });
  let ownerId = 'own_abc' as OwnerId;
  let email = 'kevin.weaver2@gmail.com';
  const principal = () => ({ ownerId, verifiedEmail: email } as AuthPrincipal);
  const auth = {
    authenticateRequest: vi.fn(async (): Promise<Authentication> => ({ kind: 'authenticated', context: { principal: principal(), csrfToken: 'csrf' } })),
    requireHumanMutation: vi.fn(async (request: Request): Promise<MutationAuthorization> => request.headers.get('x-khala-csrf') !== 'csrf'
      ? { kind: 'rejected', code: 'csrf_mismatch' }
      : { kind: 'authorized', context: { principal: principal(), csrfToken: 'csrf' } }),
  };
  const deps = { auth, store, clock, random: randomBytes,
    setDisplayName: vi.fn(async () => true), afterUsernameChange: vi.fn(async () => {}) };
  const request = (body?: unknown, csrf = true) => new Request('https://khala.test/api/human/profile',
    body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', ...(csrf ? { 'x-khala-csrf': 'csrf' } : {}) }, body: JSON.stringify(body) });
  const handlers = createProfileHandlers(deps);
  const set = (username: string) => handlers.setUsername(request({ username }));
  const seed = (key: string, value: { [key: string]: string | number | null }) => store.compareAndSet({ key, expectedRevision: null, operationId: randomBytes(8).toString('hex'), next: { value, expiresAt: null } });
  return { deps, store, handlers, request, set, seed, owner: (id: string) => { ownerId = id as OwnerId; }, email: (value: string) => { email = value; } };
}
it('suggests the email name with no lookup and returns null for owners without a profile', async () => {
  const f = fixture();
  expect(await (await f.handlers.get(f.request())).json()).toEqual({ username: null, suggestion: 'Kevin', color: defaultHumanColor('own_abc'), initials: null });
  // Someone else already being Kevin no longer changes the suggestion: usernames are not unique.
  f.owner('other'); await f.set('Kevin'); f.owner('own_abc');
  expect(await (await f.handlers.get(f.request())).json()).toMatchObject({ username: null, suggestion: 'Kevin' });
});
it('stores the profile without reserving the name, then updates Matrix', async () => {
  const f = fixture(); const response = await f.set(' Kevin ');
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ username: 'Kevin' });
  const profile = await f.store.read(profileRecordKey('own_abc'));
  expect(profile.kind === 'record' && profile.record.value).toEqual({ v: 1, ownerId: 'own_abc', username: 'Kevin', updatedAt: '2026-10-02T18:00:00.000Z' });
  expect(await f.store.read(nameKey('Kevin'))).toEqual({ kind: 'absent' });
  expect(f.deps.setDisplayName).toHaveBeenCalledWith('own_abc', 'Kevin');
  expect(f.deps.afterUsernameChange).toHaveBeenCalledWith('own_abc', null, 'Kevin');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await (await f.handlers.get(f.request())).json()).toEqual({ username: 'Kevin', suggestion: 'Kevin', color: defaultHumanColor('own_abc'), initials: null });
});
it('lets two people hold the same username, in any case', async () => {
  const f = fixture(); expect((await f.set('Kevin')).status).toBe(200);
  f.owner('other'); const response = await f.set('kevin');
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ username: 'kevin' });
  const other = await f.store.read(profileRecordKey('other'));
  expect(other.kind === 'record' && other.record.value).toMatchObject({ ownerId: 'other', username: 'kevin' });
});
it('ignores legacy human and agent reservations of the name', async () => {
  const f = fixture();
  await f.seed(nameKey('Kevin'), { v: 1, kind: 'agent', ownerId: 'own_abc', matrixUserId: '@agent:matrix.test' });
  await f.seed(nameKey('Kev'), { v: 1, kind: 'human', ownerId: 'other' });
  expect((await f.set('Kevin')).status).toBe(200);
  expect((await f.set('Kev')).status).toBe(200);
});
it('allows case changes and repairs display names on identical retries', async () => {
  const f = fixture(); await f.set('Kevin');
  expect((await f.set('KEVIN')).status).toBe(200);
  f.deps.setDisplayName.mockClear(); f.deps.afterUsernameChange.mockClear();
  expect((await f.set('KEVIN')).status).toBe(200);
  expect(f.deps.setDisplayName).toHaveBeenCalledWith('own_abc', 'KEVIN');
  expect(f.deps.afterUsernameChange).not.toHaveBeenCalled();
});
it('reports the previous username to the agent cascade', async () => {
  const f = fixture(); await f.set('Kevin'); expect((await f.set('Kev')).status).toBe(200);
  expect(f.deps.afterUsernameChange).toHaveBeenLastCalledWith('own_abc', 'Kevin', 'Kev');
});
it('rejects invalid names and non-exact request bodies', async () => {
  const f = fixture(); const response = await f.set('k');
  expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'invalid_username', reason: 'too_short' });
  for (const body of [{}, { username: 'Kevin', extra: true }, [], null]) {
    const response = await f.handlers.setUsername(f.request(body));
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'invalid_request' });
  }
});
it('checks human authentication and mutation authorization', async () => {
  const f = fixture(); expect((await f.handlers.setUsername(f.request({ username: 'Kevin' }, false))).status).toBe(403);
  f.deps.auth.authenticateRequest.mockResolvedValue({ kind: 'signed_out' });
  expect((await f.handlers.get(f.request())).status).toBe(401);
  for (const code of ['signed_out', 'forbidden_origin', 'csrf_mismatch'] as const) {
    f.deps.auth.requireHumanMutation.mockResolvedValue({ kind: 'rejected', code });
    expect((await f.set('Kevin')).status).toBe(code === 'signed_out' ? 401 : 403);
  }
});
it('keeps successful writes when Matrix or post-change hooks fail', async () => {
  const f = fixture(); const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    f.deps.setDisplayName.mockResolvedValueOnce(false).mockRejectedValueOnce(Error('private detail'));
    f.deps.afterUsernameChange.mockRejectedValue(Error('private detail'));
    expect((await f.set('Kevin')).status).toBe(200);
    expect((await f.set('Kev')).status).toBe(200);
    expect(log.mock.calls.flat()).not.toContain('private detail');
  } finally { log.mockRestore(); }
});
it('fails closed on unavailable reads and profile writes', async () => {
  const f = fixture(); vi.spyOn(f.store, 'read').mockResolvedValue({ kind: 'unavailable' });
  expect((await f.handlers.get(f.request())).status).toBe(503); expect((await f.set('Kevin')).status).toBe(503);
  const g = fixture(); vi.spyOn(g.store, 'compareAndSet').mockResolvedValue({ kind: 'unavailable' });
  expect((await g.set('Kevin')).status).toBe(503); expect(g.deps.setDisplayName).not.toHaveBeenCalled();
});
it('retries a profile conflict once and reports the latest previous name', async () => {
  const f = fixture(); await f.set('Kevin');
  const cas = f.store.compareAndSet.bind(f.store); let raced = false;
  vi.spyOn(f.store, 'compareAndSet').mockImplementation(async input => {
    if (input.key.startsWith('profiles/') && !raced) {
      raced = true;
      await cas({ ...input, operationId: 'racing-update', next: { value: { v: 1, ownerId: 'own_abc', username: 'Kev', updatedAt: '2026-10-02T18:00:00.000Z' }, expiresAt: null } });
    }
    return cas(input);
  });
  expect((await f.set('Kevin2')).status).toBe(200);
  expect(f.deps.afterUsernameChange).toHaveBeenLastCalledWith('own_abc', 'Kev', 'Kevin2');
});
it('bounds repeated profile conflicts without reporting success', async () => {
  const f = fixture(); const cas = f.store.compareAndSet.bind(f.store);
  const spy = vi.spyOn(f.store, 'compareAndSet').mockImplementation(input => input.key.startsWith('profiles/') ? Promise.resolve({ kind: 'conflict', current: null }) : cas(input));
  expect((await f.set('Kevin')).status).toBe(503);
  expect(spy.mock.calls.filter(([input]) => input.key.startsWith('profiles/'))).toHaveLength(2);
  expect(f.deps.setDisplayName).not.toHaveBeenCalled();
});
it('resolves an applied profile write with an uncertain response', async () => {
  const f = fixture(); const cas = f.store.compareAndSet.bind(f.store);
  const writes = vi.spyOn(f.store, 'compareAndSet').mockImplementation(async input => {
    const result = await cas(input);
    return result.kind === 'applied' ? { kind: 'outcome_unknown', operationId: input.operationId } : result;
  });
  const resolve = vi.spyOn(f.store, 'resolve');
  expect((await f.set('Kevin')).status).toBe(200);
  expect(writes).toHaveBeenCalledTimes(1);
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(f.deps.setDisplayName).toHaveBeenCalledTimes(1);
  expect((await f.store.read(profileRecordKey('own_abc'))).kind).toBe('record');
});
it('fails closed when a profile write remains uncertain', async () => {
  const f = fixture(); const cas = f.store.compareAndSet.bind(f.store);
  vi.spyOn(f.store, 'compareAndSet').mockImplementation(async input => input.key === profileRecordKey('own_abc')
    ? { kind: 'outcome_unknown', operationId: input.operationId } : cas(input));
  vi.spyOn(f.store, 'resolve').mockImplementation(async input => ({ kind: 'outcome_unknown', operationId: input.operationId }));
  expect((await f.set('Kevin')).status).toBe(503);
  expect(f.deps.setDisplayName).not.toHaveBeenCalled();
  expect(f.deps.afterUsernameChange).not.toHaveBeenCalled();
});
it('rejects malformed and mismatched stored profiles before writes or Matrix updates', async () => {
  for (const value of [{ v: 1, ownerId: 'own_abc', username: 'Kevin' },
    { v: 1, ownerId: 'other', username: 'Kevin', updatedAt: '2026-10-02T18:00:00.000Z' }]) {
    const f = fixture(); await f.seed(profileRecordKey('own_abc'), value);
    const writes = vi.spyOn(f.store, 'compareAndSet');
    expect((await f.handlers.get(f.request())).status).toBe(503);
    expect((await f.set('Kev')).status).toBe(503);
    expect(writes).not.toHaveBeenCalled();
    expect(f.deps.setDisplayName).not.toHaveBeenCalled();
  }
});
it('keeps the profile change when reading the previous reservation is unavailable', async () => {
  const f = fixture(); await f.set('Kevin');
  const read = f.store.read.bind(f.store);
  vi.spyOn(f.store, 'read').mockImplementation(key => key === nameKey('Kevin') ? Promise.resolve({ kind: 'unavailable' }) : read(key));
  expect((await f.set('Kev')).status).toBe(200);
  expect(f.deps.setDisplayName).toHaveBeenLastCalledWith('own_abc', 'Kev');
  expect(f.deps.afterUsernameChange).toHaveBeenLastCalledWith('own_abc', 'Kevin', 'Kev');
});
it('skips Matrix updates when the committed profile cannot be reread', async () => {
  const f = fixture(); const read = f.store.read.bind(f.store); let profileReads = 0;
  vi.spyOn(f.store, 'read').mockImplementation(key => key === profileRecordKey('own_abc') && ++profileReads > 1
    ? Promise.resolve({ kind: 'unavailable' }) : read(key));
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect((await f.set('Kevin')).status).toBe(200);
    expect(f.deps.setDisplayName).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('profile_display_name_unavailable');
    expect(f.deps.afterUsernameChange).toHaveBeenCalledWith('own_abc', null, 'Kevin');
  } finally { log.mockRestore(); }
});

it('stores a colour independently of username and skips identical chosen-colour writes', async () => {
  const f = fixture(); const writes = vi.spyOn(f.store, 'compareAndSet');
  expect(await (await f.handlers.get(f.request())).json()).toMatchObject({ color: defaultHumanColor('own_abc'), initials: null });
  const response = await f.handlers.setColor(f.request({ color: 'pink' }));
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ color: 'pink' });
  expect(writes).toHaveBeenCalledTimes(1);
  const stored = await f.store.read(humanColorRecordKey('own_abc'));
  expect(stored.kind === 'record' && stored.record.value).toEqual({ v: 1, ownerId: 'own_abc', color: 'pink' });
  expect((await f.store.read(profileRecordKey('own_abc'))).kind).toBe('absent');
  expect((await f.store.read(nameKey('Kevin'))).kind).toBe('absent');
  expect(f.deps.setDisplayName).not.toHaveBeenCalled();
  expect(f.deps.afterUsernameChange).not.toHaveBeenCalled();
  expect(await (await f.handlers.get(f.request())).json()).toEqual({ username: null, suggestion: 'Kevin', color: 'pink', initials: null });
  expect((await f.handlers.setColor(f.request({ color: 'pink' }))).status).toBe(200);
  expect(writes).toHaveBeenCalledTimes(1);
});
it('rejects invalid colour ids and non-exact colour bodies', async () => {
  const f = fixture(); const writes = vi.spyOn(f.store, 'compareAndSet');
  for (const color of ['chartreuse', '#ff0000', 'Pink', '', null, 1]) {
    const response = await f.handlers.setColor(f.request({ color }));
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'invalid_color' });
  }
  for (const body of [{}, { color: 'pink', extra: true }, [], null]) {
    const response = await f.handlers.setColor(f.request(body));
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'invalid_request' });
  }
  expect((await f.handlers.setColor(new Request('https://khala.test/api/human/profile/color', {
    method: 'POST', headers: { 'x-khala-csrf': 'csrf' }, body: '{',
  }))).status).toBe(400);
  expect(writes).not.toHaveBeenCalled();
});
it('requires human mutation authorization for colours, including CSRF', async () => {
  const f = fixture(); const writes = vi.spyOn(f.store, 'compareAndSet');
  expect((await f.handlers.setColor(f.request({ color: 'pink' }, false))).status).toBe(403);
  expect(f.deps.auth.requireHumanMutation).toHaveBeenCalledTimes(1);
  expect(f.deps.auth.authenticateRequest).not.toHaveBeenCalled();
  for (const code of ['signed_out', 'forbidden_origin', 'csrf_mismatch'] as const) {
    f.deps.auth.requireHumanMutation.mockResolvedValue({ kind: 'rejected', code });
    expect((await f.handlers.setColor(f.request({ color: 'pink' }))).status).toBe(code === 'signed_out' ? 401 : 403);
  }
  expect(writes).not.toHaveBeenCalled();
});
it('defaults corrupt or mismatched colour records and overwrites their revisions', async () => {
  for (const value of [{ v: 1, ownerId: 'own_abc', color: 'chartreuse' },
    { v: 1, ownerId: 'other', color: 'pink' }]) {
    const f = fixture(); await f.seed(humanColorRecordKey('own_abc'), value);
    expect(await (await f.handlers.get(f.request())).json()).toMatchObject({ color: defaultHumanColor('own_abc'), initials: null });
    // Even a request matching the fallback must repair the corrupt stored record.
    const color = defaultHumanColor('own_abc');
    const writes = vi.spyOn(f.store, 'compareAndSet');
    expect((await f.handlers.setColor(f.request({ color }))).status).toBe(200);
    expect(writes).toHaveBeenCalledTimes(1);
    const read = await f.store.read(humanColorRecordKey('own_abc'));
    expect(read.kind === 'record' && read.record.value).toEqual({ v: 1, ownerId: 'own_abc', color });
  }
});
it('retries a colour conflict once and bounds repeated conflicts', async () => {
  const f = fixture(); const cas = f.store.compareAndSet.bind(f.store); let raced = false;
  const writes = vi.spyOn(f.store, 'compareAndSet').mockImplementation(async input => {
    if (!raced) {
      raced = true;
      await cas({ ...input, operationId: 'racing-colour', next: { value: { v: 1, ownerId: 'own_abc', color: 'blue' }, expiresAt: null } });
    }
    return cas(input);
  });
  expect((await f.handlers.setColor(f.request({ color: 'pink' }))).status).toBe(200);
  expect(writes).toHaveBeenCalledTimes(2);
  expect(await (await f.handlers.get(f.request())).json()).toMatchObject({ color: 'pink' });
  const g = fixture(); const conflicts = vi.spyOn(g.store, 'compareAndSet').mockResolvedValue({ kind: 'conflict', current: null });
  expect((await g.handlers.setColor(g.request({ color: 'pink' }))).status).toBe(503);
  expect(conflicts).toHaveBeenCalledTimes(2);
});
it('returns unavailable for colour read/write failures and resolves uncertain writes', async () => {
  const f = fixture(); const read = f.store.read.bind(f.store);
  vi.spyOn(f.store, 'read').mockImplementation(key => key === humanColorRecordKey('own_abc') ? Promise.resolve({ kind: 'unavailable' }) : read(key));
  expect((await f.handlers.get(f.request())).status).toBe(503);
  expect((await f.handlers.setColor(f.request({ color: 'pink' }))).status).toBe(503);
  const g = fixture(); vi.spyOn(g.store, 'compareAndSet').mockResolvedValue({ kind: 'unavailable' });
  expect((await g.handlers.setColor(g.request({ color: 'pink' }))).status).toBe(503);
  const h = fixture(); const cas = h.store.compareAndSet.bind(h.store);
  vi.spyOn(h.store, 'compareAndSet').mockImplementation(async input => {
    const written = await cas(input);
    return written.kind === 'applied' ? { kind: 'outcome_unknown', operationId: input.operationId } : written;
  });
  const resolve = vi.spyOn(h.store, 'resolve');
  expect((await h.handlers.setColor(h.request({ color: 'pink' }))).status).toBe(200);
  expect(resolve).toHaveBeenCalledTimes(1);
});

it('stores initials independently of username and skips identical chosen-initials writes', async () => {
  const f = fixture(); const writes = vi.spyOn(f.store, 'compareAndSet');
  expect(await (await f.handlers.get(f.request())).json()).toMatchObject({ initials: null });
  const response = await f.handlers.setInitials(f.request({ initials: 'kw' }));
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ initials: 'KW' });
  expect(writes).toHaveBeenCalledTimes(1);
  const stored = await f.store.read(humanInitialsRecordKey('own_abc'));
  expect(stored.kind === 'record' && stored.record.value).toEqual({ v: 1, ownerId: 'own_abc', initials: 'KW' });
  expect((await f.store.read(profileRecordKey('own_abc'))).kind).toBe('absent');
  expect((await f.store.read(humanColorRecordKey('own_abc'))).kind).toBe('absent');
  expect((await f.store.read(nameKey('Kevin'))).kind).toBe('absent');
  expect(f.deps.setDisplayName).not.toHaveBeenCalled();
  expect(f.deps.afterUsernameChange).not.toHaveBeenCalled();
  expect(await (await f.handlers.get(f.request())).json()).toEqual({ username: null, suggestion: 'Kevin', color: defaultHumanColor('own_abc'), initials: 'KW' });
  expect((await f.handlers.setInitials(f.request({ initials: 'KW' }))).status).toBe(200);
  expect(writes).toHaveBeenCalledTimes(1);
});
it('rejects invalid initials and non-exact initials bodies', async () => {
  const f = fixture(); const writes = vi.spyOn(f.store, 'compareAndSet');
  for (const initials of [false, {}, [], 'K', 'KWS', 'K ', ' K', 'K.', '😀K', '👍🏽', 'ß', 'ßa', '', 1]) {
    const response = await f.handlers.setInitials(f.request({ initials }));
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'invalid_initials' });
  }
  for (const body of [{}, { initials: 'KW', extra: true }, [], null]) {
    const response = await f.handlers.setInitials(f.request(body));
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'invalid_request' });
  }
  expect((await f.handlers.setInitials(new Request('https://khala.test/api/human/profile/initials', {
    method: 'POST', headers: { 'x-khala-csrf': 'csrf' }, body: '{',
  }))).status).toBe(400);
  expect(writes).not.toHaveBeenCalled();
});
it('requires human mutation authorization for initials, including CSRF', async () => {
  const f = fixture(); const writes = vi.spyOn(f.store, 'compareAndSet');
  expect((await f.handlers.setInitials(f.request({ initials: 'KW' }, false))).status).toBe(403);
  expect(f.deps.auth.requireHumanMutation).toHaveBeenCalledTimes(1);
  expect(f.deps.auth.authenticateRequest).not.toHaveBeenCalled();
  for (const code of ['signed_out', 'forbidden_origin', 'csrf_mismatch'] as const) {
    f.deps.auth.requireHumanMutation.mockResolvedValue({ kind: 'rejected', code });
    expect((await f.handlers.setInitials(f.request({ initials: 'KW' }))).status).toBe(code === 'signed_out' ? 401 : 403);
  }
  expect(f.deps.auth.authenticateRequest).not.toHaveBeenCalled();
  expect(writes).not.toHaveBeenCalled();
});
it('defaults corrupt or mismatched initials records and overwrites their revisions', async () => {
  for (const value of [{ v: 1, ownerId: 'own_abc', initials: 'kw' },
    { v: 1, ownerId: 'other', initials: 'KW' }]) {
    const f = fixture(); await f.seed(humanInitialsRecordKey('own_abc'), value);
    expect(await (await f.handlers.get(f.request())).json()).toMatchObject({ initials: null });
    // Even a request matching the fallback must repair the corrupt stored record.
    const initials = null;
    const writes = vi.spyOn(f.store, 'compareAndSet');
    expect((await f.handlers.setInitials(f.request({ initials }))).status).toBe(200);
    expect(writes).toHaveBeenCalledTimes(1);
    const read = await f.store.read(humanInitialsRecordKey('own_abc'));
    expect(read.kind === 'record' && read.record.value).toEqual({ v: 1, ownerId: 'own_abc', initials });
  }
});
it('retries an initials conflict once and bounds repeated conflicts', async () => {
  const f = fixture(); const cas = f.store.compareAndSet.bind(f.store); let raced = false;
  const writes = vi.spyOn(f.store, 'compareAndSet').mockImplementation(async input => {
    if (!raced) {
      raced = true;
      await cas({ ...input, operationId: 'racing-initials', next: { value: { v: 1, ownerId: 'own_abc', initials: 'AB' }, expiresAt: null } });
    }
    return cas(input);
  });
  expect((await f.handlers.setInitials(f.request({ initials: 'KW' }))).status).toBe(200);
  expect(writes).toHaveBeenCalledTimes(2);
  expect(await (await f.handlers.get(f.request())).json()).toMatchObject({ initials: 'KW' });
  const g = fixture(); const conflicts = vi.spyOn(g.store, 'compareAndSet').mockResolvedValue({ kind: 'conflict', current: null });
  expect((await g.handlers.setInitials(g.request({ initials: 'KW' }))).status).toBe(503);
  expect(conflicts).toHaveBeenCalledTimes(2);
});
it('returns unavailable for initials read/write failures and resolves uncertain writes', async () => {
  const f = fixture(); const read = f.store.read.bind(f.store);
  vi.spyOn(f.store, 'read').mockImplementation(key => key === humanInitialsRecordKey('own_abc') ? Promise.resolve({ kind: 'unavailable' }) : read(key));
  expect((await f.handlers.get(f.request())).status).toBe(503);
  expect((await f.handlers.setInitials(f.request({ initials: 'KW' }))).status).toBe(503);
  const g = fixture(); vi.spyOn(g.store, 'compareAndSet').mockResolvedValue({ kind: 'unavailable' });
  expect((await g.handlers.setInitials(g.request({ initials: 'KW' }))).status).toBe(503);
  const h = fixture(); const cas = h.store.compareAndSet.bind(h.store);
  vi.spyOn(h.store, 'compareAndSet').mockImplementation(async input => {
    const written = await cas(input);
    return written.kind === 'applied' ? { kind: 'outcome_unknown', operationId: input.operationId } : written;
  });
  const resolve = vi.spyOn(h.store, 'resolve');
  expect((await h.handlers.setInitials(h.request({ initials: 'KW' }))).status).toBe(200);
  expect(resolve).toHaveBeenCalledTimes(1);
});

it('clears chosen initials with a stored null record', async () => {
  const f = fixture();
  await f.handlers.setInitials(f.request({ initials: 'KW' }));
  expect(await (await f.handlers.setInitials(f.request({ initials: null }))).json()).toEqual({ initials: null });
  const read = await f.store.read(humanInitialsRecordKey('own_abc'));
  expect(read.kind === 'record' && read.record.value).toEqual({ v: 1, ownerId: 'own_abc', initials: null });
  expect(await (await f.handlers.get(f.request())).json()).toMatchObject({ initials: null });
});
