import {
  decodeHarnessCapabilities,
  type HarnessCapabilities,
  type HarnessPort,
  type SessionBinding,
} from '@khala/contracts/delivery/index';
import type { RuntimeHarnessPort } from './create';

/**
 * Projects one real harness route into the runtime's content-free readiness view.
 * Any tested, evidence-backed existing-session route may make dispatch eligible.
 */
export function createRuntimeHarnessAdapter(
  binding: SessionBinding,
  harness: HarnessPort,
): RuntimeHarnessPort {
  let selected: HarnessPort | null = null;
  return {
    async inspect() {
      const decoded = decodeHarnessCapabilities(await harness.inspect(binding));
      if (!decoded.ok) {
        selected = null;
        return { state: 'unknown', capabilities: null };
      }

      const capabilities = decoded.value;
      if (capabilities.support === 'unsupported' || capabilities.existingSession === 'unsupported') {
        selected = null;
        return { state: 'unsupported', capabilities };
      }
      if (
        capabilities.support === 'tested'
        && isDeliverableRoute(capabilities)
        && capabilities.harness === binding.harness
      ) {
        selected = harness;
        return { state: 'ready', capabilities };
      }
      selected = null;
      return { state: 'unknown', capabilities };
    },
    selected: () => selected,
    close: () => harness.close(),
  };
}

export function isDeliverableRoute(capabilities: HarnessCapabilities): boolean {
  return capabilities.existingSession !== 'unknown'
    && capabilities.existingSession !== 'unsupported'
    && capabilities.immediateNotification !== 'unknown'
    && capabilities.immediateNotification !== 'unsupported';
}
