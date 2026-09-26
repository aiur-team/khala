import type { HumanCapability } from '../human/capabilities';

/** Placeholder owned by KHA-132 until the controls composition is available. */
export function registerControls(): HumanCapability {
  return {
    id: 'controls',
    state: 'unavailable',
    attach: () => ({ dispose() {} }),
  };
}
