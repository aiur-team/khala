import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { withWakeLock } from './lock';

export interface WakeSettings {
  consent: Record<string, { at: string }>;
  off: Record<string, { at: string }>;
}
export async function readWakeSettings(root: string): Promise<WakeSettings> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(root, 'wake-settings.json'), 'utf8')) as WakeSettings;
    const entries = (input: unknown): Record<string, { at: string }> => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
      return Object.fromEntries(Object.entries(input).filter(([, entry]) => entry && typeof entry === 'object' && typeof entry.at === 'string'));
    };
    return { consent: entries(value?.consent), off: entries(value?.off) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { consent: {}, off: {} };
    throw error;
  }
}
export async function writeWakeSettings(root: string, settings: WakeSettings): Promise<void> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const target = path.join(root, 'wake-settings.json');
  const temp = `${target}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(settings), { mode: 0o600 });
    await fs.rename(temp, target);
  } finally { await fs.rm(temp, { force: true }); }
}
export async function updateWakeSettings(root: string, update: (settings: WakeSettings) => void): Promise<void> {
  await withWakeLock(root, 'wake-settings.lock', async () => {
    const settings = await readWakeSettings(root);
    update(settings);
    await writeWakeSettings(root, settings);
  });
}
export async function driverAllowed(root: string, harness: string, driver: string, optIn: boolean): Promise<boolean> {
  const settings = await readWakeSettings(root);
  const key = `${harness}/${driver}`;
  return !Object.hasOwn(settings.off, key) && (!optIn || Object.hasOwn(settings.consent, key));
}
