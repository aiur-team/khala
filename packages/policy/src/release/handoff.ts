// Retry-safe identity of a release decision for the KHA-134 command journal.

import type { ApprovalCommand, SessionBinding } from '@khala/contracts/delivery/index';
import { type DigestResult, sha256Digest } from './codec';

/** Domain separator of the version 1 decision fingerprint. */
export const DECISION_FINGERPRINT_V1 = 'khala.release-decision.v1';

/**
 * `sha256:` digest of UTF-8 compact JSON
 * `["khala.release-decision.v1",commandId,roomId,bindingId,expectedPolicyVersion,
 * expectedBindingGeneration,issuedAt,[[roomId,eventId,authorParticipantId,authorDeviceId,contentDigest],...],
 * [bindingId,ownerId,agentParticipantId,deviceId,harness,sessionId,generation],policyVersion]`.
 *
 * It covers what the owner authorised and for whom, not the releaser-chosen
 * release identifiers, so a retry of the same command against the same state
 * yields the same fingerprint. Bodies are bound through their content digests.
 */
export function decisionFingerprint(
  command: ApprovalCommand,
  binding: SessionBinding,
  policyVersion: number,
): Promise<DigestResult> {
  const tuple = [
    DECISION_FINGERPRINT_V1,
    command.commandId,
    command.roomId,
    command.bindingId,
    command.expectedPolicyVersion,
    command.expectedBindingGeneration,
    command.issuedAt,
    command.selection.map(ref => [ref.roomId, ref.eventId, ref.authorParticipantId, ref.authorDeviceId, ref.contentDigest]),
    [
      binding.bindingId, binding.ownerId, binding.agentParticipantId, binding.deviceId, binding.harness,
      binding.sessionId, binding.generation,
    ],
    policyVersion,
  ];
  return sha256Digest(new TextEncoder().encode(JSON.stringify(tuple)));
}
