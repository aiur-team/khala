// Retry-safe identity of a release decision for the KHA-134 command journal.

import type { ApprovalCommand } from '@khala/contracts/delivery/index';
import { type DigestResult, sha256Digest } from './codec';

/** Domain separator of the version 1 decision fingerprint. */
export const DECISION_FINGERPRINT_V1 = 'khala.release-decision.v1';

/**
 * `sha256:` digest of UTF-8 compact JSON
 * `["khala.release-decision.v1",v,commandId,roomId,bindingId,expectedPolicyVersion,
 * expectedBindingGeneration,issuedAt,[[roomId,eventId,authorParticipantId,authorDeviceId,contentDigest],...]]`.
 *
 * It covers exactly the command fields `sameApprovalCommandInput` compares, with
 * the selection in command order, and
 * nothing from current state: a decision already requires the binding and policy
 * to equal the command's expected values. The journal can compute it before
 * evaluating, and an honest retry still matches its committed result after the
 * binding or policy moved on. Bodies are bound through their content digests.
 */
export function decisionFingerprint(command: ApprovalCommand): Promise<DigestResult> {
  const tuple = [
    DECISION_FINGERPRINT_V1,
    command.v,
    command.commandId,
    command.roomId,
    command.bindingId,
    command.expectedPolicyVersion,
    command.expectedBindingGeneration,
    command.issuedAt,
    command.selection.map(ref => [ref.roomId, ref.eventId, ref.authorParticipantId, ref.authorDeviceId, ref.contentDigest]),
  ];
  return sha256Digest(new TextEncoder().encode(JSON.stringify(tuple)));
}
