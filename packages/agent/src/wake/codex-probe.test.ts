import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { probeCodexQueue } from './codex-probe';
import { createCodexWakeDriver } from './codex';
import { filesForDir } from '../state';
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-queue-probe-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
async function binary(help: string, code = 0) {
  await fs.writeFile(path.join(root, 'codex'), `#!${process.execPath}\nimport fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(path.join(root, 'calls'))}, JSON.stringify(process.argv.slice(2))+'\\n'); console.log(${JSON.stringify(help)}); process.exit(${code});\n`, { mode: 0o700 });
}
it('reports missing executables and a missing queue subcommand', async () => {
  expect(await probeCodexQueue({ PATH: root })).toMatchObject({ available: false, reason: 'codex_binary_missing' });
  await binary('unknown command', 1);
  const ctx = { files: filesForDir(root), harness: 'codex', sessionId: 'thread', env: { PATH: root }, now: 0, signal: new AbortController().signal };
  const driver = createCodexWakeDriver();
  expect(await driver.available(ctx)).toBe(false);
  expect(await driver.unavailableReason?.(ctx)).toBe('codex_queue_unavailable');
});
it('requires both flags and caches concurrent probes until binary mtime changes', async () => {
  await binary('--thread');
  expect(await probeCodexQueue({ PATH: root })).toMatchObject({ available: false });
  await binary('--thread --message');
  const future = new Date(Date.now() + 1000);
  await fs.utimes(path.join(root, 'codex'), future, future);
  expect(await Promise.all(Array.from({ length: 5 }, () => probeCodexQueue({ PATH: root })))).toEqual(Array(5).fill({ available: true, command: path.join(root, 'codex') }));
  expect((await fs.readFile(path.join(root, 'calls'), 'utf8')).trim().split('\n')).toEqual(['["queue","--help"]', '["queue","--help"]']);
});
