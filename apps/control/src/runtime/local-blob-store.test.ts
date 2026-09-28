import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLocalBlobStores } from './local-blob-store';

describe('filesystem local blob stores', () => {
  it('shares records across instances while enforcing single-key CAS', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'khala-local-store-'));
    try {
      const first = createLocalBlobStores(directory)('first');
      const otherInstance = createLocalBlobStores(directory)('first');
      const second = createLocalBlobStores(directory)('second');
      const created = await first.setJSON('key', { value: 1 }, { onlyIfNew: true });
      expect(created.modified).toBe(true);
      expect(await otherInstance.getWithMetadata('key')).toEqual({ data: { value: 1 }, etag: created.etag });
      expect((await otherInstance.setJSON('key', { value: 2 }, { onlyIfNew: true })).modified).toBe(false);
      expect((await first.setJSON('key', { value: 3 }, { onlyIfMatch: 'wrong' })).modified).toBe(false);
      expect((await first.setJSON('key', { value: 4 }, { onlyIfMatch: created.etag! })).modified).toBe(true);
      expect((await otherInstance.getWithMetadata('key'))?.data).toEqual({ value: 4 });
      expect(await second.getWithMetadata('key')).toBeNull();
      const competing = await Promise.all(Array.from({ length: 8 }, (_, index) =>
        createLocalBlobStores(directory)('first').setJSON('race', { index }, { onlyIfNew: true })));
      expect(competing.filter(result => result.modified)).toHaveLength(1);
      const winner = competing.findIndex(result => result.modified);
      expect((await first.getWithMetadata('race'))?.data).toEqual({ index: winner });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('never reclaims an old lock while concurrent CAS waiters are racing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'khala-local-store-'));
    try {
      const store = createLocalBlobStores(directory)('first');
      const original = await store.setJSON('key', { value: 'original' }, { onlyIfNew: true });
      const digest = (value: string) => createHash('sha256').update(value).digest('hex');
      const lock = join(directory, digest('first'), `${digest('key')}.json.lock`);
      await mkdir(lock);
      const old = new Date(Date.now() - 60_000);
      await utimes(lock, old, old);
      const attempts = await Promise.allSettled([1, 2].map(value =>
        createLocalBlobStores(directory)('first').setJSON('key', { value }, { onlyIfMatch: original.etag! })));
      expect(attempts.map(result => result.status)).toEqual(['rejected', 'rejected']);
      expect(await store.getWithMetadata('key')).toEqual({ data: { value: 'original' }, etag: original.etag });
      await rm(lock, { recursive: true });
      expect((await store.setJSON('key', { value: 'recovered' }, { onlyIfMatch: original.etag! })).modified).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
