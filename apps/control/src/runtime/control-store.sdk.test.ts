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
});
