import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openSessionDir, type SessionFiles } from './state';
import { readActivity, writeActivity } from './activity';
let root: string;
let files: SessionFiles;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-activity-'));
  files = await openSessionDir('claude', 'session', { XDG_STATE_HOME: root });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
it('defaults missing or invalid activity to busy and writes private atomic activity', async () => {
  const fallback = { state: 'busy', updatedAt: new Date(0).toISOString() };
  expect(await readActivity(files)).toEqual(fallback);
  const now = () => new Date('2026-10-02T10:04:00Z');
  expect(await writeActivity(files, 'idle', now)).toEqual({ state: 'idle', updatedAt: now().toISOString() });
  expect((await readActivity(files)).state).toBe('idle');
  const file = path.join(files.dir, 'activity.json');
  expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  for (const value of ['garbage', 'null', '{}', '{"state":"idle","updatedAt":"bad"}', '{"state":"other","updatedAt":"2026-10-02T10:04:00Z"}']) {
    await fs.writeFile(file, value);
    expect(await readActivity(files)).toEqual(fallback);
  }
});
