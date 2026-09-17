import { open, mkdir, readFile, writeFile, unlink, access } from 'node:fs/promises';
/** Conservative lock: abrupt death requires explicit local stale-lock removal. */
export async function acquireStore(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = await open(`${directory}/writer.lock`, 'wx', 0o600).catch(() => { throw new Error('store locked: duplicate writer or interrupted shutdown'); });
  await lock.writeFile(String(process.pid));
  return async () => { await lock.close(); await unlink(`${directory}/writer.lock`); };
}
export async function checkIdentity(directory: string, identity: object, create: boolean) {
  const marker = `${directory}/identity.json`;
  if (create) {
    try { await access(marker); } catch { await writeFile(marker, JSON.stringify(identity), { flag:'wx', mode:0o600 }); return; }
  }
  const saved = await readFile(marker, 'utf8').catch(() => { throw new Error('missing identity: explicit new-device enrollment required'); });
  if (saved !== JSON.stringify(identity)) throw new Error('lost or replaced crypto store');
}
