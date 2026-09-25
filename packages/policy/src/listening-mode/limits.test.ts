import { describe, expect, it } from 'vitest';
import { approvedAutomation } from '../trust/gate';
import { LOCAL_AUTOMATION_LIMITS } from './limits';

type Job = Readonly<{ root: string; depth: number }>;

function retainWithinProfile(jobs: readonly Job[]): Job[] {
  const perRoot = new Map<string, number>();
  const retained: Job[] = [];
  for (const job of jobs) {
    const count = perRoot.get(job.root) ?? 0;
    if (job.depth >= LOCAL_AUTOMATION_LIMITS.maxCausalDepth) continue;
    if (count >= LOCAL_AUTOMATION_LIMITS.maxJobsPerCausalRoot) continue;
    retained.push(job);
    perRoot.set(job.root, count + 1);
  }
  return retained;
}

describe('local listening-mode automation profile', () => {
  it('pins the approved local-only limits', () => {
    expect(LOCAL_AUTOMATION_LIMITS).toEqual({
      maxCausalDepth: 3,
      maxJobsPerCausalRoot: 3,
      maxConcurrentJobs: 1,
      busy: 'wait',
    });
    expect(Object.isFrozen(LOCAL_AUTOMATION_LIMITS)).toBe(true);
  });

  it('retains a representative two-agent completion inside one causal root', () => {
    const exchange = [
      { root: 'human-message-1', depth: 0 },
      { root: 'human-message-1', depth: 1 },
      { root: 'human-message-1', depth: 2 },
    ];
    expect(retainWithinProfile(exchange)).toEqual(exchange);
  });

  it('stops a self-sustaining loop and lets a new human root start fresh', () => {
    const runaway = Array.from({ length: 10 }, (_, depth) => ({ root: 'loop-root', depth }));
    expect(retainWithinProfile(runaway)).toEqual(runaway.slice(0, 3));

    const nextHumanRoot = [{ root: 'human-message-2', depth: 0 }];
    expect(retainWithinProfile([...runaway, ...nextHumanRoot])).toContainEqual(nextHumanRoot[0]);
  });

  it('keeps hosted automation closed instead of supplying the local profile', () => {
    expect(approvedAutomation()).toBeNull();
    expect(approvedAutomation()).not.toBe(LOCAL_AUTOMATION_LIMITS);
  });
});
