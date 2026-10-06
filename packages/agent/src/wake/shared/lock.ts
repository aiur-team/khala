import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

async function clearAbandonedLock(lock: string): Promise<void> {
  let entries: string[];
  try { entries = await fs.readdir(lock); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    const owner = /^owner-(\d+)-[a-f0-9]{16}$/.exec(entry);
    if (!owner) continue;
    try { process.kill(Number(owner[1]), 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue;
      // Delete only the observed generation. A replacement lock's owner has
      // a different filename, so competing reclaimers cannot remove it.
      await fs.rm(path.join(lock, entry), { force: true });
    }
  }
  // Acquisition publishes a populated directory atomically. rmdir therefore
  // cannot delete a successor, even if another process reclaimed this lock.
  try { await fs.rmdir(lock); }
  catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
}
export async function withWakeLock<T>(dir: string, name: string, work: () => T | Promise<T>): Promise<T> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, name);
  const owner = `owner-${process.pid}-${randomBytes(8).toString('hex')}`;
  const candidate = path.join(dir, `.${owner}`);
  await fs.mkdir(candidate, { mode: 0o700 });
  await fs.writeFile(path.join(candidate, owner), '', { mode: 0o600 });
  let acquired = false;
  try {
    for (let tries = 0; tries < 200; tries++) {
      try { await fs.rename(candidate, lock); acquired = true; break; }
      catch (error) { if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
      await clearAbandonedLock(lock);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  } finally {
    if (!acquired) await fs.rm(candidate, { recursive: true, force: true });
  }
  if (!acquired) throw new Error('wake_state_locked');
  try { return await work();
  } finally {
    await fs.rm(path.join(lock, owner), { force: true });
    try { await fs.rmdir(lock); }
    catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  }
}
