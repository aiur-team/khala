// The idle wake is driven by the ledger's own controls at arrival, never by a caller-supplied mode.

import { describe, expect, it } from 'vitest';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import { listening, makeRelease, testPolicy, world } from './fixtures/fakes';

type Wake = Readonly<{ binding: SessionBinding; mode: string }>;

async function arrival(policy: ReturnType<typeof testPolicy> | null, fail = false) {
  const w = await world(policy);
  const wakes: Wake[] = [];
  const dispatcher = w.dispatcher({
    idleWake: { wake: async (binding, mode) => { wakes.push({ binding, mode }); if (fail) throw new Error('boom'); } },
  });
  const { job } = w.add(makeRelease({ releaseId: 'release-1' }));
  const result = await dispatcher.enqueue(job);
  await dispatcher.idle();
  await new Promise(resolve => setTimeout(resolve, 0));
  return { w, wakes, result, dispatcher, job };
}

describe('idle wake on arrival', () => {
  it.each(['steer', 'sync'] as const)('wakes once with the effective %s mode', async mode => {
    const { wakes, job } = await arrival(testPolicy({ listening: listening(mode) }));
    expect(wakes).toEqual([{ binding: job.binding, mode }]);
  });

  it('does not wake for async', async () => {
    expect((await arrival(testPolicy({ listening: listening('async') }))).wakes).toEqual([]);
  });

  it('does not wake a paused binding', async () => {
    expect((await arrival(testPolicy({ paused: true }))).wakes).toEqual([]);
  });

  it('does not wake when the effective mode differs from the requested mode', async () => {
    const policy = testPolicy({ listening: listening('sync', { requested: 'steer' }) });
    expect((await arrival(policy)).wakes).toEqual([]);
  });

  it('does not wake when no policy is usable', async () => {
    expect((await arrival(null)).wakes).toEqual([]);
  });

  it('does not wake a duplicate arrival', async () => {
    const { wakes, dispatcher, job } = await arrival(testPolicy());
    expect(await dispatcher.enqueue(job)).toBe('duplicate');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(wakes).toHaveLength(1);
  });

  it('reports a failed wake without losing the release', async () => {
    const { w, result } = await arrival(testPolicy(), true);
    expect(result).toBe('queued');
    expect(w.errors).toHaveLength(1);
  });
});
