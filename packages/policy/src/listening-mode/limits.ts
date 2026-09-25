/**
 * The provisional local-only automation profile retained by the E09 listening-mode
 * experiment. Local composition injects this value explicitly. Hosted policy must
 * continue to obtain `null` from `approvedAutomation()` and must not import it.
 */
export const LOCAL_AUTOMATION_LIMITS = Object.freeze({
  maxCausalDepth: 3,
  maxJobsPerCausalRoot: 3,
  maxConcurrentJobs: 1,
  busy: 'wait',
} as const);

export type LocalAutomationLimits = typeof LOCAL_AUTOMATION_LIMITS;
