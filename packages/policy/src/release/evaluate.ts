// Pure evaluation of one owner approval against trusted current state. It either
// returns one immutable release decision covering the whole selection or a typed
// rejection; it never releases a subset and never reads SDK, history or storage.

import {
  type EventRef, type ReleaseRejectionCode as ContractRejectionCode, releaseFromApproval, sameEventRef,
} from '@khala/contracts/delivery/index';
import { encodeMessageContent, encodeReleasePayload, isEncodableBody, sha256Digest } from './codec';
import { decisionFingerprint } from './handoff';
import type {
  EvaluateInput, Evaluation, PendingRecord, RejectionReason, ReleaseContent, ReleaseRejection, ReleaseRejectionCode,
} from './types';

const reject = (code: ReleaseRejectionCode, reason: RejectionReason, field: string): ReleaseRejection =>
  ({ ok: false, code, reason, field });

/** An opaque ledger handle: no scheme, path, query or whitespace, so never a URL or file path. */
const OPAQUE_REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

const CONTRACT_REJECTIONS: Readonly<Record<ContractRejectionCode, [ReleaseRejectionCode, RejectionReason]>> = {
  approval_mismatch: ['unavailable', 'invalid_release'],
  binding_mismatch: ['stale_binding', 'binding_mismatch'],
  stale_binding: ['stale_binding', 'stale_binding'],
  stale_policy: ['stale_policy', 'stale_policy'],
  room_mismatch: ['forbidden', 'invalid_selection'],
  selection_mismatch: ['forbidden', 'invalid_selection'],
  stale_content: ['stale_content', 'content_mismatch'],
  invalid_field: ['unavailable', 'invalid_release'],
};

/**
 * Validates owner, room membership, recipient binding and generation, policy
 * version, every author/device reference and every content digest before any
 * output exists. `command.issuedAt` is audit data and is not consulted.
 */
export async function evaluateApproval(input: EvaluateInput): Promise<Evaluation> {
  const { authority, command, binding, policyVersion, room, pending, release } = input;

  // Authority and recipient come first, so a refused owner never reaches plaintext.
  if (authority.ownerId !== binding.ownerId) return reject('forbidden', 'owner_mismatch', 'authority.ownerId');
  if (command.roomId !== room.roomId) return reject('forbidden', 'room_mismatch', 'command.roomId');
  const members = new Set(room.members);
  if (!members.has(binding.agentParticipantId)) {
    return reject('forbidden', 'recipient_not_member', 'binding.agentParticipantId');
  }
  if (command.bindingId !== binding.bindingId) return reject('stale_binding', 'binding_mismatch', 'command.bindingId');
  if (command.expectedBindingGeneration !== binding.generation) {
    return reject('stale_binding', 'stale_binding', 'command.expectedBindingGeneration');
  }
  if (command.expectedPolicyVersion !== policyVersion) {
    return reject('stale_policy', 'stale_policy', 'command.expectedPolicyVersion');
  }

  if (command.selection.length === 0) return reject('forbidden', 'invalid_selection', 'command.selection');
  const selected = new Set<string>();
  for (const [index, ref] of command.selection.entries()) {
    // Duplicates would give one approval two release interpretations.
    if (ref.roomId !== command.roomId || selected.has(ref.eventId)) {
      return reject('forbidden', 'invalid_selection', `command.selection[${index}]`);
    }
    selected.add(ref.eventId);
  }

  // Only selected identities are looked up; later arrivals stay pending untouched.
  const snapshot = new Map<string, PendingRecord[]>();
  for (const record of pending) {
    if (record.ref.roomId !== command.roomId || !selected.has(record.ref.eventId)) continue;
    snapshot.set(record.ref.eventId, [...(snapshot.get(record.ref.eventId) ?? []), record]);
  }

  const items: { ref: EventRef; content: ReleaseContent }[] = [];
  for (const [index, ref] of command.selection.entries()) {
    const field = `command.selection[${index}]`;
    const records = snapshot.get(ref.eventId) ?? [];
    if (records.length === 0) return reject('expired_content', 'missing_content', field);
    // An ambiguous snapshot cannot say which bytes the owner saw.
    if (records.length > 1 || !sameEventRef(records[0]!.ref, ref)) return reject('stale_content', 'content_mismatch', field);
    if (!members.has(ref.authorParticipantId)) return reject('forbidden', 'author_not_member', `${field}.authorParticipantId`);
    const { content } = records[0]!;
    if (content.v !== 1 || content.kind !== 'text' || !isEncodableBody(content.body)) {
      return reject('stale_content', 'unsupported_content', field);
    }
    const digest = await sha256Digest(encodeMessageContent(content));
    if (!digest.ok) return reject('unavailable', 'crypto_unavailable', field);
    if (digest.digest !== ref.contentDigest) return reject('stale_content', 'digest_mismatch', `${field}.contentDigest`);
    items.push({ ref, content });
  }

  if (typeof release.payloadRef !== 'string' || !OPAQUE_REF.test(release.payloadRef)) {
    return reject('unavailable', 'invalid_release', 'release.payloadRef');
  }
  const encoded = encodeReleasePayload({
    releaseId: release.releaseId,
    bindingId: binding.bindingId,
    generation: binding.generation,
    policyVersion,
    items,
  });
  if (!encoded.ok) return reject('unavailable', 'invalid_release', `release.${encoded.field}`);
  const payloadDigest = await sha256Digest(encoded.bytes);
  if (!payloadDigest.ok) return reject('unavailable', 'crypto_unavailable', 'release.payloadDigest');

  const released = releaseFromApproval({
    approval: command,
    items: command.selection,
    binding,
    policyVersion,
    release: { ...release, payloadDigest: payloadDigest.digest },
  });
  if (!released.ok) {
    const [code, reason] = CONTRACT_REJECTIONS[released.code];
    return reject(code, reason, released.field);
  }

  const fingerprint = await decisionFingerprint(command, binding, policyVersion);
  if (!fingerprint.ok) return reject('unavailable', 'crypto_unavailable', 'fingerprint');

  return {
    ok: true,
    decision: {
      commandId: command.commandId,
      releaseId: released.value.releaseId,
      fingerprint: fingerprint.digest,
      job: released.value,
      payload: encoded.bytes,
    },
  };
}
