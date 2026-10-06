import { expect, it, vi } from 'vitest';
import { createCodexWakeDriver } from './codex';
import { CODEX_IDLE_WAKE_NOTICE } from './idle-wake';
import { filesForDir } from '../state';

it('keeps the native Codex queue driver argv stable until the nonce transport lands', async () => {
  const run = vi.fn().mockResolvedValue({ status: 'queued' });
  const driver = createCodexWakeDriver({ port: { run } });
  const ctx = { files: filesForDir('/tmp/session'), harness: 'codex', sessionId: 'thread', env: {}, now: 0, signal: new AbortController().signal };
  expect(driver).toMatchObject({ rung: 1, minIdleMs: 0, deadlineMs: 30_000, optIn: false, verification: 'none' });
  expect(await driver.available(ctx)).toBe(true);
  await driver.wake(ctx, 'ignored');
  expect(run).toHaveBeenCalledWith(['queue', '--thread', 'thread', '--message', CODEX_IDLE_WAKE_NOTICE], ctx.signal);
});
