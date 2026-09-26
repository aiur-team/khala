import { describe, expect, it } from 'vitest';
import {
  CODEX_IDLE_WAKE_NOTICE, type CodexIdleWakeOutcome, codexDispatchIdleWake, createCodexIdleWake,
} from './idle-wake';
import { interactiveCodexCapabilities } from './interactive';

import { binding as fixtureBinding, limits } from './fakes';

const binding = fixtureBinding();
const MARKER = 'marker-body-7f3a';

function harness(outcome: () => Promise<CodexIdleWakeOutcome> = async () => ({ status: 'queued' })) {
  const runs: { argv: readonly string[]; signal: AbortSignal }[] = [];
  let live = true;
  let idle = true;
  const wake = createCodexIdleWake({
    port: { run: (argv, signal) => { runs.push({ argv, signal }); return outcome(); } },
    isCurrent: async () => live,
    isIdle: async () => idle,
    revocationPollMs: 5,
  });
  return { wake, runs, revoke: () => { live = false; }, setIdle: (value: boolean) => { idle = value; } };
}

describe('codex idle wake', () => {
  it.each(['steer', 'sync'] as const)('queues only the constant notice and session id for idle %s', async mode => {
    const { wake, runs } = harness();
    expect(await wake.wake(binding, mode, '0.154.0')).toBe('queued');
    expect(runs.map(run => run.argv)).toEqual([
      ['queue', '--thread', binding.sessionId, '--message', CODEX_IDLE_WAKE_NOTICE],
    ]);
    const argv = runs[0]!.argv.join(' ');
    for (const secret of [MARKER, binding.bindingId, 'batch']) expect(argv).not.toContain(secret);
  });

  it('never wakes an idle async session', async () => {
    const { wake, runs } = harness();
    expect(await wake.wake(binding, 'async', '0.154.0')).toBe('not_idle_mode');
    expect(runs).toHaveLength(0);
  });

  it('coalesces concurrent wakes into one queue command', async () => {
    const releases: (() => void)[] = [];
    const { wake, runs } = harness(() => new Promise(resolve => { releases.push(() => resolve({ status: 'queued' })); }));
    const first = wake.wake(binding, 'sync', '0.156.1');
    const second = wake.wake(binding, 'steer', '0.156.1');
    await new Promise(resolve => setTimeout(resolve, 0));
    const started = runs.length;
    releases.forEach(release => release());
    expect(started).toBe(1);
    expect(await Promise.all([first, second])).toEqual(['queued', 'queued']);
    const later = wake.wake(binding, 'sync', '0.156.1');
    await new Promise(resolve => setTimeout(resolve, 0));
    releases.forEach(release => release());
    expect(await later).toBe('queued');
    expect(runs).toHaveLength(2);
  });

  it('runs nothing for an unsupported version and reports a failed queue command', async () => {
    const unsupported = harness();
    expect(await unsupported.wake.wake(binding, 'sync', '0.155.0')).toBe('unsupported_version');
    expect(unsupported.runs).toHaveLength(0);
    for (const outcome of [
      { status: 'exited', code: 1 }, { status: 'not_started' }, { status: 'lost', cause: 'timeout' },
    ] as const) {
      expect(await harness(async () => outcome).wake.wake(binding, 'sync', '0.154.0')).toBe('queue_failed');
    }
    expect(await harness(async () => { throw new Error(MARKER); }).wake.wake(binding, 'sync', '0.154.0'))
      .toBe('queue_failed');
  });

  it('runs no wake for a revoked binding', async () => {
    const { wake, runs, revoke } = harness();
    revoke();
    expect(await wake.wake(binding, 'steer', '0.154.0')).toBe('revoked');
    expect(runs).toHaveLength(0);
  });

  it('aborts a wake already in flight when Stop revokes the binding', async () => {
    const { wake, runs, revoke } = harness(() => new Promise(() => {}));
    const pending = wake.wake(binding, 'sync', '0.154.0');
    await new Promise(resolve => setTimeout(resolve, 0));
    revoke();
    // The port promise never settles here, so the wake must resolve from the abort alone.
    expect(await pending).toBe('revoked');
    expect(runs[0]!.signal.aborted).toBe(true);
  });
});

describe('idle wake state and dispatch adapter', () => {
  it('drops the wake claim after a failed queue command and restores it after a success', async () => {
    let outcome: CodexIdleWakeOutcome = { status: 'exited', code: 1 };
    const { wake } = harness(async () => outcome);
    expect(wake.state(binding)).toBe('unavailable');
    await wake.wake(binding, 'sync', '0.154.0');
    expect(wake.state(binding)).toBe('unavailable');
    expect(interactiveCodexCapabilities('0.154.0', limits, { state: 'trusted' }, undefined, wake.state(binding)).immediateNotification)
      .toBe('unknown');
    outcome = { status: 'queued' };
    await wake.wake(binding, 'sync', '0.154.0');
    expect(wake.state(binding)).toBe('available');
  });

  it('makes no wake claim before a wake has succeeded', () => {
    expect(harness().wake.state(binding)).toBe('unavailable');
  });

  it('does not wake a session that is mid-turn', async () => {
    const { wake, runs, setIdle } = harness();
    setIdle(false);
    expect(await wake.wake(binding, 'sync', '0.154.0')).toBe('not_idle');
    expect(runs).toHaveLength(0);
    expect(wake.state(binding)).toBe('unavailable');
  });

  it('passes the dispatcher mode through and wakes nothing for an unknown version', async () => {
    const { wake, runs } = harness();
    await codexDispatchIdleWake(wake, async () => null).wake(binding, 'sync');
    expect(runs).toHaveLength(0);
    await codexDispatchIdleWake(wake, async () => '0.154.0').wake(binding, 'steer');
    expect(runs).toHaveLength(1);
  });
});
