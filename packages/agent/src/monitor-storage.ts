import * as fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { SessionFiles } from './state';

/** Shared across the MCP process and a shell with its own TMPDIR and PID namespace. */
export function monitorStorageCandidates(files: SessionFiles): string[] {
  const hash = createHash('sha256').update(path.resolve(files.dir)).digest('hex');
  const uid = process.getuid?.() ?? os.userInfo().username;
  return [files.dir, path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', `khala-monitor-${uid}-${hash}`)];
}
export async function monitorStorage(files: SessionFiles): Promise<string> {
  const probe = path.join(files.dir, `.monitor-probe-${randomUUID()}`);
  try {
    const handle = await fs.open(probe, 'wx', 0o600);
    await handle.close();
    await fs.unlink(probe);
    return files.dir;
  } catch (error) {
    if (!['EACCES', 'EPERM', 'EROFS'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
  const dir = monitorStorageCandidates(files)[1]!;
  await fs.mkdir(dir, { mode: 0o700 }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())
    || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new Error('unsafe_monitor_directory');
  return dir;
}
