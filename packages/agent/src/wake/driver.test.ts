import { expect, it, vi } from 'vitest';
import { createCodexWakeDriver } from './codex';
import { CODEX_IDLE_WAKE_NOTICE } from './idle-wake';
import { filesForDir } from '../state';

it('queues the nonce-bearing shared line', async () => {
  const run = vi.fn().mockResolvedValue({ status: 'queued' });
  const driver = createCodexWakeDriver({ port: { run }, probe: async () => ({ available: true }) });
  const ctx = { files: filesForDir('/tmp/session'), harness: 'codex', sessionId: 'thread', env: {}, now: 0, signal: new AbortController().signal };
  expect(driver).toMatchObject({ rung: 1, minIdleMs: 0, deadlineMs: 30_000, optIn: false, verification: 'nonce' });
  expect(await driver.available(ctx)).toBe(true);
  await driver.wake(ctx, `${CODEX_IDLE_WAKE_NOTICE} (k-12345678)`);
  expect(run).toHaveBeenCalledWith(['queue', '--thread', 'thread', '--message', `${CODEX_IDLE_WAKE_NOTICE} (k-12345678)`], ctx.signal);
});
