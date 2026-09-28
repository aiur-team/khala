import { describe, expect, it } from 'vitest';
import { closureSynapseLimitOverride } from '../../integration/fixtures/closure-synapse';

const limits = { synapse: { memoryBytes: 1024 * 1024 * 1024, cpus: 1, pids: 256 },
  postgres: { memoryBytes: 512 * 1024 * 1024, cpus: 0.5, pids: 128 } };

describe('disposable Synapse container limits', () => {
  it('sets bounded memory, no swap, CPU and PID caps on both services', () => {
    expect(closureSynapseLimitOverride(limits)).toEqual({ services: {
      synapse: { mem_limit: '1073741824', memswap_limit: '1073741824', cpus: 1, pids_limit: 256 },
      postgres: { mem_limit: '536870912', memswap_limit: '536870912', cpus: 0.5, pids_limit: 128 },
    } });
  });

  it.each([
    { ...limits, synapse: { ...limits.synapse, memoryBytes: 0 } },
    { ...limits, synapse: { ...limits.synapse, cpus: Number.POSITIVE_INFINITY } },
    { ...limits, postgres: { ...limits.postgres, pids: -1 } },
  ])('refuses invalid hard limits before a container starts', input => {
    expect(() => closureSynapseLimitOverride(input)).toThrow('closure_container_limits_invalid');
  });
});
