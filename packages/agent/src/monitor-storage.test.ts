import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { sessionFiles } from './state';
import { monitorStorage, monitorStorageCandidates } from './monitor-storage';
vi.mock('node:fs/promises', { spy: true });
const files = sessionFiles('muse', randomUUID(), { XDG_STATE_HOME: '/readonly-test-state' });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(monitorStorageCandidates(files)[1]!, { recursive: true, force: true }); });
it('falls back to private deterministic temporary storage when state is read-only', async () => {
  vi.spyOn(fs, 'open').mockRejectedValue(Object.assign(new Error('read-only'), { code: 'EROFS' }));
  const dir = await monitorStorage(files);
  expect(dir).toBe(monitorStorageCandidates(files)[1]);
  expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
  expect(await monitorStorage(files)).toBe(dir);
});
it('rejects a pre-existing unsafe temporary directory', async () => {
  vi.spyOn(fs, 'open').mockRejectedValue(Object.assign(new Error('read-only'), { code: 'EROFS' }));
  const dir = monitorStorageCandidates(files)[1]!;
  await fs.mkdir(dir, { mode: 0o777 });
  await fs.chmod(dir, 0o777);
  await expect(monitorStorage(files)).rejects.toThrow('unsafe_monitor_directory');
});
