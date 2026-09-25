import { LOCAL_AUTOMATION_LIMITS } from '@khala/policy/listening-mode/limits';
import { describe, expect, it } from 'vitest';
import {
  makeRelease, recordOf, testLimits, testPolicy, world,
} from '../../../../../packages/connector/src/dispatch/fixtures/fakes';
import { createLocalDispatcher, localDispatchLimits } from './dispatch';
import { createLocalAutomationProvider } from './provider';

const provider = () => createLocalAutomationProvider(LOCAL_AUTOMATION_LIMITS);

describe('local dispatch composition', () => {
  it('injects exactly the dispatch share of the local profile', () => {
    expect(localDispatchLimits(provider())).toStrictEqual({
      maxJobsPerCausalRoot: LOCAL_AUTOMATION_LIMITS.maxJobsPerCausalRoot,
      maxConcurrentJobs: LOCAL_AUTOMATION_LIMITS.maxConcurrentJobs,
      busy: 'wait',
    });
  });

  it('holds the profile even when the caller passes looser limits', async () => {
    // The world's own limits are the loose fixture values: 10 concurrent jobs, `queue` when busy.
    const w = await world(testPolicy(), ['bind-1', 'bind-2'], testLimits());
    const dispatcher = createLocalDispatcher(provider(), w.deps());
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-1', bindingId: 'bind-1' })).job);
    await dispatcher.enqueue(w.add(makeRelease({ releaseId: 'release-2', bindingId: 'bind-2' })).job);
    await dispatcher.idle();
    // The injected `maxConcurrentJobs: 1` holds the second binding; the caller's 10 never applies.
    expect(w.harness.submittedIds()).toEqual(['release-1']);
    expect(await recordOf(w.ledger, 'release-2')).toMatchObject({ state: 'queued', reason: 'at_capacity' });
  });
});
