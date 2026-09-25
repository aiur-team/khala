import type { DispatchLimits } from '@khala/connector/dispatch/index';
import { LOCAL_AUTOMATION_LIMITS } from '@khala/policy/listening-mode/limits';

/**
 * The dispatcher's share of the approved local automation profile. Composition passes this to
 * `createDispatcher`; no binding policy or caller option can change it. `maxCausalDepth` stays with
 * automatic release, its sole enforcer, and is deliberately not copied here.
 */
export const LOCAL_DISPATCH_LIMITS: DispatchLimits = Object.freeze({
  maxJobsPerCausalRoot: LOCAL_AUTOMATION_LIMITS.maxJobsPerCausalRoot,
  maxConcurrentJobs: LOCAL_AUTOMATION_LIMITS.maxConcurrentJobs,
  busy: LOCAL_AUTOMATION_LIMITS.busy,
});
