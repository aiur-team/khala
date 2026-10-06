import { wakeLine } from './shared';
import { expect, it } from 'vitest';
import { CODEX_IDLE_WAKE_NOTICE, codexIdleWakeArgv } from './idle-wake';

it('queues a nonce-bearing content-free notice for the specified thread', () => {
  expect(codexIdleWakeArgv('thread-1', wakeLine('12345678'))).toEqual(['queue', '--thread', 'thread-1', '--message', wakeLine('12345678')]);
  expect(CODEX_IDLE_WAKE_NOTICE).not.toMatch(/[{$\n]/);
});
