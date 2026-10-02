import { expect, it } from 'vitest';
import { CODEX_IDLE_WAKE_NOTICE, codexIdleWakeArgv } from './idle-wake';

it('queues a constant content-free notice for the specified thread', () => {
  expect(codexIdleWakeArgv('thread-1')).toEqual(['queue', '--thread', 'thread-1', '--message', CODEX_IDLE_WAKE_NOTICE]);
  expect(CODEX_IDLE_WAKE_NOTICE).not.toMatch(/[{$\n]/);
});
