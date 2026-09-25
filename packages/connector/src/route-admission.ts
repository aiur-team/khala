import type { HarnessCapabilities } from '@khala/contracts/delivery/index';

/**
 * Whether capabilities prove delivery into an existing session for the bound harness.
 * The agent-installed listener remains an explicit experimental fallback: it is never
 * admitted merely because a harness reports it.
 */
export function admitsExistingSessionRoute(
  capabilities: HarnessCapabilities,
  harness: string,
  allowExperimentalAgentListener = false,
): boolean {
  if (capabilities.harness !== harness) return false;
  if (capabilities.existingSession === 'agent_installed_listener') {
    return allowExperimentalAgentListener
      && capabilities.support === 'experimental'
      && capabilities.immediateNotification === 'agent_installed_listener';
  }
  if (capabilities.support !== 'tested'
    || typeof capabilities.evidenceRef !== 'string'
    || capabilities.evidenceRef.length === 0) return false;
  return (capabilities.existingSession === 'khala_hosted_resume'
      && capabilities.immediateNotification === 'khala_hosted_idle')
    || (capabilities.existingSession === 'native_cli_queue'
      && capabilities.immediateNotification === 'native_cli_queue');
}
