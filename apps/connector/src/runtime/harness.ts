import {
  decodeHarnessCapabilities,
  type HarnessPort,
  type SessionBinding,
} from '@khala/contracts/delivery/index';
import type { RuntimeHarnessPort } from './create';

/**
 * Projects one real harness route into the runtime's content-free readiness view.
 * Only the evidence-backed hosted-resume route may make dispatch eligible.
 */
export function createRuntimeHarnessAdapter(
  binding: SessionBinding,
  harness: HarnessPort,
): RuntimeHarnessPort {
  return {
    async inspect() {
      const decoded = decodeHarnessCapabilities(await harness.inspect(binding));
      if (!decoded.ok) return { state: 'unknown' };

      const capabilities = decoded.value;
      if (capabilities.support === 'unsupported' || capabilities.existingSession === 'unsupported') {
        return { state: 'unsupported' };
      }
      if (
        capabilities.support === 'tested'
        && capabilities.existingSession === 'khala_hosted_resume'
        && capabilities.harness === binding.harness
      ) {
        return { state: 'ready' };
      }
      return { state: 'unknown' };
    },
    close: () => harness.close(),
  };
}
