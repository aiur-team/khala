import {
  type HarnessCapabilities, OPENCODE_HARNESS, OPENCODE_TESTED_VERSIONS, resolveOpenCodeModes,
} from '@khala/contracts/delivery/index';

const MODES = ['steer', 'sync', 'async'] as const;

/**
 * The OpenCode plugin route is admitted only when every claimed mode is exactly what a
 * recorded evidence key produces, at least one mode is proven, and acknowledgement goes
 * through the batch token on the next Khala call. A forged or stale row refuses the route.
 */
function admitsOpenCodePlugin(capabilities: HarnessCapabilities): boolean {
  if (capabilities.harness !== OPENCODE_HARNESS
    || capabilities.immediateNotification !== 'opencode_plugin'
    || capabilities.acknowledgement !== 'batch_token_next_call'
    || !OPENCODE_TESTED_VERSIONS.includes(capabilities.version)) return false;
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
