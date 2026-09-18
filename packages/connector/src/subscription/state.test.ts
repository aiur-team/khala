import { describe, expect, it } from 'vitest';
import { Generation, backoffDelay } from './state';

describe('backoffDelay', () => {
  const policy = { baseMs: 100, maxMs: 1_000 };

  it('grows exponentially under full jitter and never exceeds the cap', () => {
    const top = () => 0.999_999;
    expect(backoffDelay(policy, 0, top)).toBe(99);
    expect(backoffDelay(policy, 2, top)).toBe(399);
    expect(backoffDelay(policy, 10, top)).toBe(999);
    expect(backoffDelay(policy, 10_000, top)).toBe(999);
  });

  it('stays within [0, ceiling] for any random value', () => {
    expect(backoffDelay(policy, 3, () => 0)).toBe(0);
    expect(backoffDelay(policy, 3, () => -5)).toBe(0);
    expect(backoffDelay(policy, 3, () => 7)).toBe(800);
  });
});

describe('Generation', () => {
  it('invalidates every earlier generation', () => {
    const generation = new Generation();
    const first = generation.next();
    expect(generation.isCurrent(first)).toBe(true);
    const second = generation.next();
    expect(generation.isCurrent(first)).toBe(false);
    expect(generation.isCurrent(second)).toBe(true);
  });
});
