import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { driverAllowed, readWakeSettings, writeWakeSettings } from './settings';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
it('requires opt-in consent and honours machine-wide off settings', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wake-settings-')); roots.push(root);
  expect(await readWakeSettings(root)).toEqual({ consent: {}, off: {} });
  expect(await driverAllowed(root, 'codex', 'queue', false)).toBe(true);
  expect(await driverAllowed(root, 'codex', 'terminal', true)).toBe(false);
  await writeWakeSettings(root, { consent: { 'codex/terminal': { at: 'now' } }, off: {} });
  expect(await driverAllowed(root, 'codex', 'terminal', true)).toBe(true);
  expect(await driverAllowed(root, 'qwen', 'terminal', true)).toBe(false);
  await writeWakeSettings(root, { consent: { 'codex/terminal': { at: 'now' } }, off: { 'codex/terminal': { at: 'later' } } });
  expect(await driverAllowed(root, 'codex', 'terminal', true)).toBe(false);
});
