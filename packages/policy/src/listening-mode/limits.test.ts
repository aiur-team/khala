import { describe, expect, it } from 'vitest';
import { approvedAutomation } from '../trust/gate';
import { evaluateLocalAutomation, LOCAL_AUTOMATION_LIMITS, type LocalAutomationLimits } from './limits';

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
    expect(evaluateLocalAutomation(exchange)).toEqual({ decision: 'run', retained: exchange });
  });

  it('stops a self-sustaining loop and lets a new human root start fresh', () => {
    const runaway = Array.from({ length: 10 }, (_, depth) => ({ root: 'loop-root', depth }));
    expect(evaluateLocalAutomation(runaway)).toEqual({ decision: 'run', retained: runaway.slice(0, 3) });

    const nextHumanRoot = [{ root: 'human-message-2', depth: 0 }];
    expect(evaluateLocalAutomation([...runaway, ...nextHumanRoot]).retained).toContainEqual(nextHumanRoot[0]);
  });

  it('waits when the only local worker slot is busy', () => {
    const result = evaluateLocalAutomation([{ root: 'human-message-1', depth: 0 }], LOCAL_AUTOMATION_LIMITS, 1);

    expect(result).toEqual({ decision: 'wait', retained: [] });
  });

  it.each([
    ['maxCausalDepth', 0],
    ['maxJobsPerCausalRoot', 1.5],
    ['maxConcurrentJobs', Number.MAX_SAFE_INTEGER + 1],
  ] as const)('rejects an invalid %s budget', (key, value) => {
    const limits = { ...LOCAL_AUTOMATION_LIMITS, [key]: value } as LocalAutomationLimits;

    expect(() => evaluateLocalAutomation([], limits)).toThrow(RangeError);
  });

  it('keeps hosted automation closed instead of supplying the local profile', () => {
    expect(approvedAutomation()).toBeNull();
    expect(approvedAutomation()).not.toBe(LOCAL_AUTOMATION_LIMITS);
  });
});
