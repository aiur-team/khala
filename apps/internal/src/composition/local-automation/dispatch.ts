// Dispatch under the local automation profile. Hosted roots receive no local limits and
// stay `automation_gated`; only this internal composition injects the profile into
// `createDispatcher`. Dispatch enforces the per-root job, concurrency and busy limits
// at delivery. `evaluateLocalAutomaticRelease` is the sole enforcer of `maxCausalDepth`
// and reads the same provider value at release, so both layers share one profile.

import {
  createDispatcher, type DispatchDeps, type DispatchLimits, type Dispatcher,
} from '@khala/connector/dispatch/index';
import type { LocalAutomationProvider } from './provider';

/** The dispatcher's share of the provider's approved limits. */
export function localDispatchLimits(provider: LocalAutomationProvider): DispatchLimits {
  const { maxJobsPerCausalRoot, maxConcurrentJobs, busy } = provider.limits;
  return Object.freeze({ maxJobsPerCausalRoot, maxConcurrentJobs, busy });
}

/** A dispatcher bound to the local profile. Callers cannot supply their own limits. */
export function createLocalDispatcher(
  provider: LocalAutomationProvider,
  deps: Omit<DispatchDeps, 'limits'>,
): Dispatcher {
  return createDispatcher({ ...deps, limits: localDispatchLimits(provider) });
}
