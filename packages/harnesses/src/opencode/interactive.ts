// The route claim for the user's own OpenCode TUI running the installed Khala plugin,
// classified by the OpenCode version the plugin inspected. Khala never starts, hosts or
// signals OpenCode here.

import {
  type DeliveryLimits, type HarnessCapabilities, type ListeningMode, type ModeSupport,
  OPENCODE_EVIDENCE_REF, OPENCODE_EVIDENCE_REVISION, OPENCODE_ROUTE_EVIDENCE, OPENCODE_TESTED_VERSIONS,
  decodeHarnessCapabilities, openCodePluginCapabilities,
} from '@khala/contracts/delivery/index';
import { openCodeCapabilities } from './capabilities';

/** The shape the plugin reads from OpenCode's executable path, such as `1.17.10`. */
const INSPECTED_VERSION = /^\d+\.\d+\.\d+$/u;

const IDLE = 'Idle agents receive messages only at their next turn.';

/**
 * The claim for one inspected OpenCode version. A version with retained route evidence
 * is `tested`, with every recorded route proven. Any other inspected version runs the
 * same plugin but is `experimental` (decisions 34 and 37): it delivers with batch-token
 * acknowledgement, its modes are labelled experimental and take effect only under the
 * owner's experimental-route grant. A version that could not be inspected, or that the
 * contract cannot carry, claims nothing.
 */
export function installedOpenCodeCapabilities(version: string | null, limits: DeliveryLimits): HarnessCapabilities {
  if (version === null || !INSPECTED_VERSION.test(version)) return openCodeCapabilities(null, [], limits);
  if (OPENCODE_TESTED_VERSIONS.includes(version)) {
    return openCodeCapabilities(version, OPENCODE_ROUTE_EVIDENCE, limits);
  }
  const tested = OPENCODE_TESTED_VERSIONS.join(', ');
  const experimental = (mode: ListeningMode): ModeSupport => ({
    status: 'experimental',
    route: `opencode-plugin-${mode}`,
    testedVersion: version,
    evidenceRef: OPENCODE_EVIDENCE_REF,
    evidenceRevision: OPENCODE_EVIDENCE_REVISION,
    reason: `OpenCode ${version} has no retained route evidence (tested: ${tested}), so this route is experimental.`
      + (mode === 'async' ? '' : ` ${IDLE}`),
  });
  const claimed = decodeHarnessCapabilities({
    ...openCodePluginCapabilities({ version, limits, claims: [] }),
    support: 'experimental',
    existingSession: 'opencode_plugin',
    immediateNotification: 'opencode_plugin',
    busy: 'queue',
    receiptEvidence: ['harness_queued', 'outcome_unknown', 'failed'],
    reconcileByReleaseId: 'unsupported',
    modes: { steer: experimental('steer'), sync: experimental('sync'), async: experimental('async') },
    acknowledgement: 'batch_token_next_call',
  } satisfies HarnessCapabilities);
  return claimed.ok ? claimed.value : openCodeCapabilities(null, [], limits);
}
