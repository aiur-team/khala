// One live acceptance run per repository on this host. The lock is the internal
// launcher's own lease technique: an exclusive SQLite (fcntl) lock on a private
// file, which the kernel drops when the holding process exits for any reason.
// There is no TTL, no PID file and no takeover. The key is the repository alone,
// so two different profiles contend for the same lock.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { acquireRootLease } from '../../apps/internal/src/launcher/lock';
import type { HostLock, LockPort } from './types';

export function lockDirectory(stateHome: string, repository: string): string {
  if (!path.isAbsolute(stateHome)) throw new Error('the acceptance lock needs an absolute state directory');
  const key = createHash('sha256').update(repository).digest('hex').slice(0, 32);
  return path.join(stateHome, 'khala-acceptance', key);
}

export function hostLock(stateHome: string): LockPort {
  return {
    async acquire(repository): Promise<HostLock | null> {
      const directory = lockDirectory(stateHome, repository);
      fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
      const result = acquireRootLease(directory);
      if (result.kind === 'held') return null;
      if (result.kind === 'failed') throw new Error(`acceptance lock unavailable: ${result.code}`);
      return { release: async () => { result.lease.release(); } };
    },
  };
}
