import { expect, it, vi } from 'vitest';
import { startupSession } from './startup-session';

it.each([['-s', 'ses_resumed'], ['--session', 'ses_resumed'], ['--session=ses_resumed']])(
  'identifies an explicitly resumed session from %j', async (...args) => {
    const native = vi.fn(async () => []);
    expect(await startupSession(['opencode', ...args], native)).toBe('ses_resumed');
    expect(native).not.toHaveBeenCalled();
  },
);
it('reads native arguments when the Bun worker hides the resume flag', async () => {
  expect(await startupSession(['bun', '/$bunfs/root/src/cli/tui/worker.js'], async () =>
    ['opencode', '-s', 'ses_resumed'])).toBe('ses_resumed');
});
it.each([[], ['-s'], ['-s', '../escape'], ['--prompt', '-s ses_other'], ['--continue']])(
  'does not guess a session from %j', async (...args) => {
    expect(await startupSession(args, async () => args)).toBeUndefined();
  },
);
it('tolerates unavailable native process arguments', async () => {
  expect(await startupSession([], async () => { throw new Error('unavailable'); })).toBeUndefined();
});

it.each(['--fork', '--fork=true'])('does not wake the original session when resuming with %s', async fork => {
  const native = vi.fn(async () => ['opencode', '-s', 'ses_original']);
  expect(await startupSession(['opencode', '-s', 'ses_original', fork], native)).toBeUndefined();
  expect(native).not.toHaveBeenCalled();
  expect(await startupSession(['bun', 'worker.js'], async () => ['opencode', '-s', 'ses_original', fork])).toBeUndefined();
});
