import { getStore } from '@netlify/blobs';
import { describe, expect, it } from 'vitest';
import { createControlStore } from './control-store';

type Blob = { body: string; etag: string };

/** The real SDK runs its HTTP and retry logic against this isolated fetch. */
function sdkFixture(fail: (store: string, method: string) => number | null, omitEtag: (store: string) => boolean = () => false) {
  const entries = new Map<string, Blob>();
  let revision = 0;
  const readOrigins: string[] = [];
  const putAttempts = new Map<string, number>();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const [, , store, ...keyParts] = url.pathname.split('/');
    const key = `${store}/${keyParts.join('/')}`;
    const method = (init?.method ?? 'get').toLowerCase();
    if (method === 'get') readOrigins.push(url.origin);
    if (method === 'put') putAttempts.set(store ?? '', (putAttempts.get(store ?? '') ?? 0) + 1);
    const status = fail(store ?? '', method);
    if (status !== null) {
      return new Response('rejected', { status });
    }
    const current = entries.get(key);
    if (method === 'get') {
      return current
        ? new Response(current.body, { status: 200, headers: omitEtag(store ?? '') ? {} : { etag: current.etag, 'content-type': 'application/json' } })
        : new Response(null, { status: 404 });
    }
    if (method !== 'put') throw new Error(`unexpected method ${method}`);
    const headers = new Headers(init?.headers);
    if ((headers.get('if-none-match') === '*' && current) ||
      (headers.has('if-match') && current?.etag !== headers.get('if-match'))) {
      return new Response(null, { status: 412 });
    }
    revision += 1;
    const etag = `revision-${revision}`;
    entries.set(key, { body: String(init?.body), etag });
    return new Response(null, { status: 200, headers: omitEtag(store ?? '') ? {} : { etag } });
  };
  const options = { siteID: 'isolated-site', token: 'test-token', edgeURL: 'https://cached.invalid', uncachedEdgeURL: 'https://strong.invalid', fetch };
  const store = createControlStore({
    records: getStore({ ...options, name: 'records' }),
    operations: getStore({ ...options, name: 'operations' }),
    clock: () => Date.parse('2026-09-26T00:00:00Z'),
  });
  return { store, entries, readOrigins, putAttempts };
}

describe('control store with Netlify Blobs SDK HTTP responses', () => {
  for (const status of [401, 403, 429, 503]) {
    it(`never claims a rejected operation ledger PUT (HTTP ${status})`, async () => {
      const fixture = sdkFixture((store, method) => store === 'site:operations' && method === 'put' ? status : null);
      const result = await fixture.store.compareAndSet({ key: 'owner/key', expectedRevision: null, operationId: `ledger-${status}`, next: { value: 'value', expiresAt: null } });
      expect(result).toEqual({ kind: 'outcome_unknown', operationId: `ledger-${status}` });
      expect(fixture.entries.size).toBe(0);
      if (status === 429 || status === 503) expect(fixture.putAttempts.get('site:operations')).toBe(6);
    });

    it(`never applies a rejected record PUT (HTTP ${status})`, async () => {
      const fixture = sdkFixture((store, method) => store === 'site:records' && method === 'put' ? status : null);
      const result = await fixture.store.compareAndSet({ key: 'owner/key', expectedRevision: null, operationId: `record-${status}`, next: { value: 'value', expiresAt: null } });
      expect(result).toEqual({ kind: 'outcome_unknown', operationId: `record-${status}` });
      expect(await fixture.store.read('owner/key')).toEqual({ kind: 'absent' });
      if (status === 429 || status === 503) expect(fixture.putAttempts.get('site:records')).toBe(6);
    });
  }

  for (const storeName of ['site:operations', 'site:records']) {
    it(`never applies a successful ${storeName} write whose SDK response has no ETag`, async () => {
      const fixture = sdkFixture(() => null, store => store === storeName);
      const result = await fixture.store.compareAndSet({ key: 'owner/key', expectedRevision: null, operationId: 'no-etag', next: { value: 'value', expiresAt: null } });
      expect(result).toEqual({ kind: 'outcome_unknown', operationId: 'no-etag' });
    });
  }

  it('applies a valid conditional write after a strong readback of the same ETag and bytes', async () => {
    const fixture = sdkFixture(() => null);
    const result = await fixture.store.compareAndSet({ key: 'owner/key', expectedRevision: null, operationId: 'valid', next: { value: { owner: 'alice' }, expiresAt: null } });
    expect(result).toMatchObject({ kind: 'applied', record: { value: { owner: 'alice' }, operationId: 'valid' } });
    expect(fixture.readOrigins.length).toBeGreaterThanOrEqual(3);
    expect(fixture.readOrigins.every(origin => origin === 'https://strong.invalid')).toBe(true);
  });

  it('keeps fragment-bearing ledger and record keys distinct over the real SDK transport', async () => {
    const fixture = sdkFixture(() => null);
    const key = 'channel-access-exchange/abc';
    const bound = await fixture.store.compareAndSet({ key, expectedRevision: null,
      operationId: `${key}#1.bound.digest`, next: { value: { phase: 'bound' }, expiresAt: null } });
    expect(bound.kind).toBe('applied');
    if (bound.kind !== 'applied') return;
    const admitting = await fixture.store.compareAndSet({ key, expectedRevision: bound.record.revision,
      operationId: `${key}#2.admitting.digest`, next: { value: { phase: 'admitting' }, expiresAt: null } });
    expect(admitting.kind).toBe('applied');
    expect(await fixture.store.read(key)).toMatchObject({ kind: 'record', record: { value: { phase: 'admitting' } } });

    const issuance = `${key}#issuance`;
    expect((await fixture.store.compareAndSet({ key: issuance, expectedRevision: null,
      operationId: `${issuance}#claim`, next: { value: { phase: 'reserved' }, expiresAt: null } })).kind).toBe('applied');
    expect(await fixture.store.read(issuance)).toMatchObject({ kind: 'record', record: { value: { phase: 'reserved' } } });
    expect(await fixture.store.read(key)).toMatchObject({ kind: 'record', record: { value: { phase: 'admitting' } } });
    expect([...fixture.entries.keys()].filter(entry => entry.includes('#'))).toEqual([]);
  });

  it('resumes a legacy bound claim while admitting uses its own ledger key', async () => {
    const fixture = sdkFixture(() => null);
    const key = 'channel-access-exchange/legacy';
    const boundId = `${key}#1.bound.digest`;
    const boundValue = { phase: 'bound' };
    const boundDigest = JSON.stringify([boundValue, null]);
    fixture.entries.set(`site:operations/${key}`, { body: JSON.stringify({ key, digest: boundDigest }), etag: 'legacy-ledger' });
    fixture.entries.set(`site:records/${key}`, { body: JSON.stringify({ operationId: boundId,
      value: boundValue, expiresAt: null }), etag: 'legacy-bound' });
    const loaded = await fixture.store.read(key);
    expect(loaded).toMatchObject({ kind: 'record', record: { revision: 'legacy-bound', value: boundValue } });
    if (loaded.kind !== 'record') return;
    expect((await fixture.store.compareAndSet({ key, expectedRevision: null, operationId: boundId,
      next: { value: boundValue, expiresAt: null } })).kind).toBe('applied');
    expect((await fixture.store.compareAndSet({ key, expectedRevision: null, operationId: boundId,
      next: { value: { phase: 'changed' }, expiresAt: null } })).kind).toBe('operation_mismatch');
    const admitting = await fixture.store.compareAndSet({ key, expectedRevision: loaded.record.revision,
      operationId: `${key}#2.admitting.digest`, next: { value: { phase: 'admitting' }, expiresAt: null } });
    expect(admitting.kind).toBe('applied');
    if (admitting.kind !== 'applied') return;
    const sealed = await fixture.store.compareAndSet({ key, expectedRevision: admitting.record.revision,
      operationId: `${key}#3.sealed.digest`, next: { value: { phase: 'sealed' }, expiresAt: null } });
    expect(sealed.kind).toBe('applied');
    expect((await fixture.store.compareAndSet({ key, expectedRevision: null, operationId: boundId,
      next: { value: { phase: 'changed' }, expiresAt: null } })).kind).toBe('operation_mismatch');
    expect(await fixture.store.read(key)).toMatchObject({ kind: 'record', record: { value: { phase: 'sealed' } } });
  });

  it('refuses an ambiguous legacy ledger collision without its matching record', async () => {
    const fixture = sdkFixture(() => null);
    const key = 'channel-access-exchange/ambiguous';
    fixture.entries.set(`site:operations/${key}`, { body: JSON.stringify({ key,
      digest: JSON.stringify([{ phase: 'bound' }, null]) }), etag: 'orphan-ledger' });
    expect(await fixture.store.compareAndSet({ key, expectedRevision: null,
      operationId: `${key}#2.admitting.digest`, next: { value: { phase: 'admitting' }, expiresAt: null } }))
      .toEqual({ kind: 'outcome_unknown', operationId: `${key}#2.admitting.digest` });
    expect(await fixture.store.read(key)).toEqual({ kind: 'absent' });
  });

  it('migrates a proven legacy fragment record before advancing its revision', async () => {
    const fixture = sdkFixture(() => null);
    const base = 'channel-access-operation-binding/legacy';
    const key = `${base}#issuance`;
    const priorId = `${key}#claim`;
    const priorValue = { phase: 'reserved' };
    fixture.entries.set(`site:records/${base}`, { body: JSON.stringify({ operationId: priorId,
      value: priorValue, expiresAt: null }), etag: 'legacy-issuance' });
    const read = await fixture.store.read(key);
    expect(read).toMatchObject({ kind: 'record', record: { revision: 'legacy-issuance', value: priorValue } });
    if (read.kind !== 'record') return;
    const advanced = await fixture.store.compareAndSet({ key, expectedRevision: read.record.revision,
      operationId: `${key}#advance`, next: { value: { phase: 'advanced' }, expiresAt: null } });
    expect(advanced.kind).toBe('applied');
    expect(await fixture.store.read(key)).toMatchObject({ kind: 'record', record: { value: { phase: 'advanced' } } });
    expect((await fixture.store.compareAndSet({ key, expectedRevision: read.record.revision,
      operationId: `${key}#advance`, next: { value: { phase: 'advanced' }, expiresAt: null } })).kind).toBe('applied');
    expect(await fixture.store.read(base)).toMatchObject({ kind: 'record', record: { value: priorValue } });
  });

  it('continues reading existing dotted record keys at their original physical path', async () => {
    const fixture = sdkFixture(() => null);
    const key = 'auth.session.v1.existing';
    fixture.entries.set(`site:records/${key}`, { body: JSON.stringify({ operationId: 'session-op',
      value: { phase: 'active' }, expiresAt: null }), etag: 'existing-revision' });
    expect(await fixture.store.read(key)).toMatchObject({ kind: 'record', record: { revision: 'existing-revision' } });
  });

  it('keeps standalone dot path segments separate from normalized-looking keys', async () => {
    const fixture = sdkFixture(() => null);
    for (const [key, operationId] of [['a/../b', 'dotdot'], ['a/./b', 'dot'], ['b', 'plain']] as const) {
      expect((await fixture.store.compareAndSet({ key, expectedRevision: null, operationId,
        next: { value: operationId, expiresAt: null } })).kind).toBe('applied');
    }
    expect(await fixture.store.read('a/../b')).toMatchObject({ kind: 'record', record: { value: 'dotdot' } });
    expect(await fixture.store.read('a/./b')).toMatchObject({ kind: 'record', record: { value: 'dot' } });
    expect(await fixture.store.read('b')).toMatchObject({ kind: 'record', record: { value: 'plain' } });
  });
});
