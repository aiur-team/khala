import {
  decodeHarnessCapabilities,
  type DeliveryLimits,
  type HarnessCapabilities,
  unknownModeSupportMap,
} from '@khala/contracts/delivery/index';

export const FALLBACK_SKILL_VERSION = 'skill-1';
export const FALLBACK_ADAPTER_VERSION = 'agent-listener-1';

export function fallbackSkillCapabilities(harness: string, limits: DeliveryLimits): HarnessCapabilities {
  const decoded = decodeHarnessCapabilities({
    v: 3,
    harness,
    version: FALLBACK_SKILL_VERSION,
    adapterVersion: FALLBACK_ADAPTER_VERSION,
    support: 'experimental',
    existingSession: 'agent_installed_listener',
    immediateNotification: 'agent_installed_listener',
    busy: 'unknown',
    receiptEvidence: [],
    reconcileByReleaseId: 'unsupported',
    limits,
    evidenceRef: null,
    modes: unknownModeSupportMap(
      `${harness}-agent-listener`,
      'The fallback listener has no retained primary-mode proof; idle agents receive messages only at their next turn.',
      FALLBACK_SKILL_VERSION,
    ),
    acknowledgement: 'unknown',
  });
  if (!decoded.ok) throw new TypeError(`invalid fallback capability: ${decoded.field}`);
  return decoded.value;
}
