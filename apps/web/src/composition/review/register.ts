import type { HumanCapability } from '../human/capabilities';

/** Placeholder owned by KHA-132 until the review composition is available. */
export function registerReview(): HumanCapability {
  return {
    id: 'review',
    state: 'unavailable',
    attach: () => ({ dispose() {} }),
  };
}
