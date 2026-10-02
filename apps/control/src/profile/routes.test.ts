import { randomBytes } from 'node:crypto';
import { expect, it, vi } from 'vitest';
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
  const seed = (key: string, value: { [key: string]: string | number }) => store.compareAndSet({ key, expectedRevision: null, operationId: randomBytes(8).toString('hex'), next: { value, expiresAt: null } });
  return { deps, store, handlers, request, set, seed, owner: (id: string) => { ownerId = id as OwnerId; }, email: (value: string) => { email = value; } };
}
it('suggests an available username and returns null for existing owners without a profile', async () => {
  const f = fixture();
  expect(await (await f.handlers.get(f.request())).json()).toEqual({ username: null, suggestion: 'Kevin' });
  await f.seed(nameKey('Kevin'), { v: 1, kind: 'human', ownerId: 'other' });
  expect(await (await f.handlers.get(f.request())).json()).toEqual({ username: null, suggestion: 'Kevin2' });
});
it('stores the profile and reservation then updates Matrix', async () => {
  const f = fixture(); const response = await f.set(' Kevin ');
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ username: 'Kevin' });
  const profile = await f.store.read(profileRecordKey('own_abc'));
  expect(profile.kind === 'record' && profile.record.value).toEqual({ v: 1, ownerId: 'own_abc', username: 'Kevin', updatedAt: '2026-10-02T18:00:00.000Z' });
  const reservation = await f.store.read(nameKey('Kevin'));
  expect(reservation.kind === 'record' && reservation.record.value).toEqual({ v: 1, kind: 'human', ownerId: 'own_abc' });
  expect(f.deps.setDisplayName).toHaveBeenCalledWith('own_abc', 'Kevin');
  expect(f.deps.afterUsernameChange).toHaveBeenCalledWith('own_abc', null, 'Kevin');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await (await f.handlers.get(f.request())).json()).toEqual({ username: 'Kevin', suggestion: 'Kevin' });
});
it('rejects another owner claiming a case-insensitive reservation', async () => {
  const f = fixture(); expect((await f.set('Kevin')).status).toBe(200);
  f.owner('other'); const response = await f.set('kevin');
  expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'username_taken' });
  expect((await f.store.read(profileRecordKey('other'))).kind).toBe('absent');
});
it('allows case changes and repairs display names on identical retries', async () => {
  const f = fixture(); await f.set('Kevin');
  expect((await f.set('KEVIN')).status).toBe(200);
  const reservation = await f.store.read(nameKey('Kevin')); expect(reservation.kind).toBe('record');
  f.deps.setDisplayName.mockClear(); f.deps.afterUsernameChange.mockClear();
  expect((await f.set('KEVIN')).status).toBe(200);
  expect(f.deps.setDisplayName).toHaveBeenCalledWith('own_abc', 'KEVIN');
  expect(f.deps.afterUsernameChange).not.toHaveBeenCalled();
});
it('releases the previous username so another owner can claim it', async () => {
  const f = fixture(); await f.set('Kevin'); expect((await f.set('Kev')).status).toBe(200);
  expect(await f.store.read(nameKey('Kevin'))).toEqual({ kind: 'absent' });
  expect(f.deps.afterUsernameChange).toHaveBeenLastCalledWith('own_abc', 'Kevin', 'Kev');
  f.owner('other'); expect((await f.set('Kevin')).status).toBe(200);
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
it('does not treat agent reservations as the same human owner', async () => {
  const f = fixture(); await f.seed(nameKey('Kevin'), { v: 1, kind: 'agent', ownerId: 'own_abc', matrixUserId: '@agent:matrix.test' });
  expect((await f.set('Kevin')).status).toBe(409);
  expect(await (await f.handlers.get(f.request())).json()).toEqual({ username: null, suggestion: 'Kevin2' });
});
it('truncates suggestion suffixes and bounds exhausted suggestions', async () => {
  const f = fixture(); f.email('a'.repeat(24) + '@x');
  await f.seed(nameKey('A' + 'a'.repeat(23)), { v: 1, kind: 'human', ownerId: 'other' });
  expect(await (await f.handlers.get(f.request())).json()).toEqual({ username: null, suggestion: 'A' + 'a'.repeat(22) + '2' });
  const g = fixture();
  for (const suffix of ['', ...Array.from({ length: 98 }, (_, i) => String(i + 2))]) {
    await g.seed(nameKey('Kevin' + suffix), { v: 1, kind: 'human', ownerId: 'other' });
  }
  expect((await g.handlers.get(g.request())).status).toBe(503);
});
it('fails closed on unavailable reads, reservations and profile writes', async () => {
  const f = fixture(); vi.spyOn(f.store, 'read').mockResolvedValue({ kind: 'unavailable' });
  expect((await f.handlers.get(f.request())).status).toBe(503); expect((await f.set('Kevin')).status).toBe(503);
  const g = fixture(); vi.spyOn(g.store, 'compareAndSet').mockResolvedValue({ kind: 'unavailable' });
  expect((await g.set('Kevin')).status).toBe(503); expect(g.deps.setDisplayName).not.toHaveBeenCalled();
  const h = fixture(); const cas = h.store.compareAndSet.bind(h.store);
  vi.spyOn(h.store, 'compareAndSet').mockImplementation(input => input.key.startsWith('profiles/') ? Promise.resolve({ kind: 'unavailable' }) : cas(input));
  expect((await h.set('Kevin')).status).toBe(503);
  h.deps.store.compareAndSet = cas;
  expect((await h.set('Kevin')).status).toBe(200); // own reservation is retryable
});
it('retries a profile conflict once and releases the latest previous name', async () => {
  const f = fixture(); await f.set('Kevin');
  const cas = f.store.compareAndSet.bind(f.store); let raced = false;
  vi.spyOn(f.store, 'compareAndSet').mockImplementation(async input => {
    if (input.key.startsWith('profiles/') && !raced) {
      raced = true;
      await f.seed(nameKey('Kev'), { v: 1, kind: 'human', ownerId: 'own_abc' });
      await cas({ ...input, operationId: 'racing-update', next: { value: { v: 1, ownerId: 'own_abc', username: 'Kev', updatedAt: '2026-10-02T18:00:00.000Z' }, expiresAt: null } });
    }
    return cas(input);
  });
  expect((await f.set('Kevin2')).status).toBe(200);
  expect(f.deps.afterUsernameChange).toHaveBeenLastCalledWith('own_abc', 'Kev', 'Kevin2');
  expect((await f.store.read(nameKey('Kev'))).kind).toBe('absent');
});
it('bounds repeated profile conflicts without reporting success', async () => {
  const f = fixture(); const cas = f.store.compareAndSet.bind(f.store);
  const spy = vi.spyOn(f.store, 'compareAndSet').mockImplementation(input => input.key.startsWith('profiles/') ? Promise.resolve({ kind: 'conflict', current: null }) : cas(input));
  expect((await f.set('Kevin')).status).toBe(503);
  expect(spy.mock.calls.filter(([input]) => input.key.startsWith('profiles/'))).toHaveLength(2);
  expect(f.deps.setDisplayName).not.toHaveBeenCalled();
});
it('does not release a username reclaimed while an earlier release is delayed', async () => {
  const f = fixture(); await f.set('Kevin');
  const cas = f.store.compareAndSet.bind(f.store);
  let resume!: () => void; let reached!: () => void;
  const paused = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  let delayed = false;
  vi.spyOn(f.store, 'compareAndSet').mockImplementation(async input => {
    if (input.key === nameKey('Kevin') && input.next.expiresAt !== null && !delayed) {
      delayed = true; reached(); await gate;
    }
    return cas(input);
  });
  const first = f.set('Kev'); await paused;
  const otherHandler = createProfileHandlers(f.deps);
  expect((await otherHandler.setUsername(f.request({ username: 'Kevin' }))).status).toBe(200);
  resume(); expect((await first).status).toBe(200);
  expect(f.deps.setDisplayName).toHaveBeenLastCalledWith('own_abc', 'Kevin');
  expect((await f.store.read(nameKey('Kevin'))).kind).toBe('record');
  f.owner('other'); expect((await f.set('Kevin')).status).toBe(409);
});
it('reserves again after a profile conflict when its pending claim was released', async () => {
  const f = fixture(); await f.set('Kevin');
  const cas = f.store.compareAndSet.bind(f.store);
  let raced = false;
  vi.spyOn(f.store, 'compareAndSet').mockImplementation(async input => {
    if (input.key === profileRecordKey('own_abc') && !raced) {
      raced = true;
      const claim = await f.store.read(nameKey('Kev'));
      if (claim.kind !== 'record') throw Error('pending claim missing');
      await cas({ key: nameKey('Kev'), expectedRevision: claim.record.revision, operationId: 'expire-pending-claim',
        next: { value: claim.record.value, expiresAt: new Date(f.deps.clock()).toISOString() } });
      await cas({ ...input, operationId: 'concurrent-profile-update', next: { value: { v: 1, ownerId: 'own_abc', username: 'Kevin2', updatedAt: new Date(f.deps.clock()).toISOString() }, expiresAt: null } });
    }
    return cas(input);
  });
  expect((await f.set('Kev')).status).toBe(200);
  expect((await f.store.read(nameKey('Kev'))).kind).toBe('record');
  f.owner('other'); expect((await f.set('Kev')).status).toBe(409);
});
it('resolves applied reservation and profile writes with uncertain responses', async () => {
  const f = fixture(); const cas = f.store.compareAndSet.bind(f.store);
  const writes = vi.spyOn(f.store, 'compareAndSet').mockImplementation(async input => {
    const result = await cas(input);
    return result.kind === 'applied' ? { kind: 'outcome_unknown', operationId: input.operationId } : result;
  });
  const resolve = vi.spyOn(f.store, 'resolve');
  expect((await f.set('Kevin')).status).toBe(200);
  expect(writes).toHaveBeenCalledTimes(2);
  expect(resolve).toHaveBeenCalledTimes(2);
  expect(f.deps.setDisplayName).toHaveBeenCalledTimes(1);
  expect((await f.store.read(nameKey('Kevin'))).kind).toBe('record');
  expect((await f.store.read(profileRecordKey('own_abc'))).kind).toBe('record');
});
it('fails closed when a reservation or profile write remains uncertain', async () => {
  for (const uncertainKey of [nameKey('Kevin'), profileRecordKey('own_abc')]) {
    const f = fixture(); const cas = f.store.compareAndSet.bind(f.store);
    vi.spyOn(f.store, 'compareAndSet').mockImplementation(async input => input.key === uncertainKey
      ? { kind: 'outcome_unknown', operationId: input.operationId } : cas(input));
    vi.spyOn(f.store, 'resolve').mockImplementation(async input => ({ kind: 'outcome_unknown', operationId: input.operationId }));
    expect((await f.set('Kevin')).status).toBe(503);
    expect(f.deps.setDisplayName).not.toHaveBeenCalled();
    expect(f.deps.afterUsernameChange).not.toHaveBeenCalled();
  }
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
