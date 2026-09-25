/**
 * The provisional local-only automation profile retained by the E09 listening-mode
 * experiment. Only the internal app's local composition may import it, and it injects
 * the value explicitly; hosted composition injects `CLOSED_AUTOMATION` instead.
 */
export type LocalAutomationLimits = Readonly<{
  maxCausalDepth: number;
  maxJobsPerCausalRoot: number;
  maxConcurrentJobs: number;
  busy: 'wait';
}>;

export type LocalAutomationJob = Readonly<{
  root: string;
  depth: number;
}>;

export type LocalAutomationEvaluation = Readonly<{
  decision: 'run' | 'wait';
  retained: readonly LocalAutomationJob[];
}>;

export const LOCAL_AUTOMATION_LIMITS: LocalAutomationLimits = Object.freeze({
  maxCausalDepth: 3,
  maxJobsPerCausalRoot: 3,
  maxConcurrentJobs: 1,
  busy: 'wait',
});

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function validateLimits(limits: LocalAutomationLimits): void {
  assertPositiveSafeInteger(limits.maxCausalDepth, 'maxCausalDepth');
  assertPositiveSafeInteger(limits.maxJobsPerCausalRoot, 'maxJobsPerCausalRoot');
  assertPositiveSafeInteger(limits.maxConcurrentJobs, 'maxConcurrentJobs');
}

/**
 * Applies the local automation fence to a proposed causal-job sequence.
 *
 * When all local worker slots are occupied, local composition must wait before
 * scheduling further work. Otherwise, jobs beyond either causal limit are
 * omitted. Limits are always injected; there is no default profile.
 */
export function evaluateLocalAutomation(
  jobs: readonly LocalAutomationJob[],
  limits: LocalAutomationLimits,
  activeJobs = 0,
): LocalAutomationEvaluation {
  validateLimits(limits);

  if (!Number.isSafeInteger(activeJobs) || activeJobs < 0) {
    throw new RangeError('activeJobs must be a non-negative safe integer');
  }

  if (activeJobs >= limits.maxConcurrentJobs) {
    return { decision: limits.busy, retained: [] };
  }

  const perRoot = new Map<string, number>();
  const retained: LocalAutomationJob[] = [];
  for (const job of jobs) {
    const count = perRoot.get(job.root) ?? 0;
    if (job.depth >= limits.maxCausalDepth) continue;
    if (count >= limits.maxJobsPerCausalRoot) continue;
    retained.push(job);
    perRoot.set(job.root, count + 1);
  }

  return { decision: 'run', retained };
}
