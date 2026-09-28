import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { BlobsStoreLike } from './control-store';

type Stored = Readonly<{ data: unknown; etag: string }>;

async function read(path: string): Promise<Stored | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as Stored; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Disposable local CAS storage shared by Netlify dev function instances. */
export function createLocalBlobStores(directory: string): (name: string) => BlobsStoreLike {
  const stores = new Map<string, BlobsStoreLike>();
  return name => {
    const existing = stores.get(name);
    if (existing) return existing;
    const folder = join(directory, createHash('sha256').update(name).digest('hex'));
    const pathFor = (key: string) => join(folder, `${createHash('sha256').update(key).digest('hex')}.json`);
    const store: BlobsStoreLike = {
      async getWithMetadata(key) { return read(pathFor(key)); },
      async setJSON(key, data, options) {
        await mkdir(folder, { recursive: true });
        const path = pathFor(key);
        const lock = `${path}.lock`;
        let acquired = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          try { await mkdir(lock); acquired = true; break; }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            // A crashed local function may leave its lock behind. A normal write
            // completes well within this bound; stale locks can be reclaimed.
            try {
              if (Date.now() - (await stat(lock)).mtimeMs > 30_000) await rm(lock, { recursive: true, force: true });
            } catch (staleError) {
              if ((staleError as NodeJS.ErrnoException).code !== 'ENOENT') throw staleError;
            }
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }
        if (!acquired) throw new Error('local control store lock unavailable');
        try {
          const current = await read(path);
          if (options?.onlyIfNew && current) return { modified: false, etag: current.etag };
          if (options?.onlyIfMatch && current?.etag !== options.onlyIfMatch) {
            return current ? { modified: false, etag: current.etag } : { modified: false };
          }
          const etag = randomUUID();
          const temporary = `${path}.${etag}.tmp`;
          try {
            const file = await open(temporary, 'wx', 0o600);
            try { await file.writeFile(JSON.stringify({ data, etag } satisfies Stored)); }
            finally { await file.close(); }
            await rename(temporary, path);
          } finally { await rm(temporary, { force: true }); }
          return { modified: true, etag };
        } finally { await rm(lock, { recursive: true, force: true }); }
      },
    };
    stores.set(name, store);
    return store;
  };
}

/** The local directory is ignored by git; only explicit development mode selects this adapter. */
export const localBlobStores = createLocalBlobStores(join(process.cwd(), '.netlify', 'khala-local-state'));
