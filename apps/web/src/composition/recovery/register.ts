import type { HumanCapability } from '../human/capabilities';

/** Placeholder owned by KHA-132 until the recovery composition is available. */
export function registerRecovery(): HumanCapability {
  return {
    id: 'recovery',
    state: 'unavailable',
    attach: () => ({ dispose() {} }),
  };
}
