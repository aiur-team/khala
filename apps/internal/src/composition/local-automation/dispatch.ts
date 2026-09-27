// Contract/reference wrapper for the generic connector dispatcher. Internal
// production uses the existing pull inbox and native hooks, with its own
// journaled-admission authority in local-automation/ledger.ts; no synthetic
// hosted approval command or connector ACK is minted for that path.

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
