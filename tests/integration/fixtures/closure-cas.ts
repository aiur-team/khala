import { DatabaseSync } from 'node:sqlite';
import type { BlobsStoreLike } from '../../../apps/control/src/runtime/control-store';

/** Disposable disk-backed single-process CAS stand-in for Netlify Blobs. Never presented as hosted proof. */
export function openClosureFixtureStores(filename: string): Readonly<{
  records: BlobsStoreLike; operations: BlobsStoreLike; close(): void;
}> {
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS objects (bucket TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(bucket,key));');
  const get = db.prepare('SELECT revision, value FROM objects WHERE bucket = ? AND key = ?');
  const put = db.prepare('INSERT INTO objects(bucket,key,revision,value) VALUES (?,?,?,?) ON CONFLICT(bucket,key) DO UPDATE SET revision=excluded.revision,value=excluded.value');
  function bucket(name: string): BlobsStoreLike {
    return {
      async getWithMetadata(key) {
        const found = get.get(name, key) as { revision: number; value: string } | undefined;
        return found ? { data: JSON.parse(found.value) as unknown, etag: String(found.revision) } : null;
      },
      async setJSON(key, data, options) {
        db.exec('BEGIN IMMEDIATE');
        try {
          const found = get.get(name, key) as { revision: number } | undefined;
          const accepted = options?.onlyIfNew ? found === undefined
            : options?.onlyIfMatch !== undefined ? found !== undefined && String(found.revision) === options.onlyIfMatch
              : true;
          if (!accepted) { db.exec('ROLLBACK'); return { modified: false }; }
          const revision = (found?.revision ?? 0) + 1;
          put.run(name, key, revision, JSON.stringify(data));
          db.exec('COMMIT');
          return { modified: true, etag: String(revision) };
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      },
    };
  }
  return { records: bucket('records'), operations: bucket('operations'), close: () => db.close() };
}
