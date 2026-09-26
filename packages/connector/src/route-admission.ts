import {
  type HarnessCapabilities, OPENCODE_HARNESS, resolveOpenCodeModes,
} from '@khala/contracts/delivery/index';

const MODES = ['steer', 'sync', 'async'] as const;

/**
 * The OpenCode plugin route is admitted only when every claimed mode is exactly what a
 * recorded evidence key produces and at least one mode is proven. The resolver owns the
 * version and `batch_token_next_call` acknowledgement rules, so a forged, stale or
 * unacknowledged claim refuses the route.
 */
function admitsOpenCodePlugin(capabilities: HarnessCapabilities): boolean {
  if (capabilities.harness !== OPENCODE_HARNESS
    || capabilities.immediateNotification !== 'opencode_plugin') return false;
  const resolved = resolveOpenCodeModes(capabilities);
  return MODES.every(mode => resolved[mode] === capabilities.modes[mode])
    && MODES.some(mode => resolved[mode].status === 'proven');
}

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
  if (capabilities.existingSession === 'opencode_plugin') return admitsOpenCodePlugin(capabilities);
  return (capabilities.existingSession === 'khala_hosted_resume'
      && capabilities.immediateNotification === 'khala_hosted_idle')
    || (capabilities.existingSession === 'native_cli_queue'
      && capabilities.immediateNotification === 'native_cli_queue');
}
