import { mkdtemp, rm } from 'node:fs/promises';
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
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
