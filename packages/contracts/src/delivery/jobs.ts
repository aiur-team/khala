// A release binds exact ordered event references to one immutable recipient
// generation and policy revision, and records the approval that authorised it.
// Payload bytes are encoded by KHA-119, not here.

import { type SessionBinding, readSessionBinding } from './binding';
import type { ApprovalCommand } from './commands';
import { type Decoded, type DeliveryLimits, decodeWith, fail, identifier, object, safeInteger, version } from './decode';
import { type EventRef, readEventSelection, readSha256Digest, sameEventIdentity, sameEventRef } from './events';
import { type CausalRootId, type CommandId, type ReleaseId, readId } from './ids';

/** The approval a release came from: its command and the state it was reviewed against. */
export type ReleaseApproval = Readonly<{
  commandId: CommandId;
  policyVersion: number;
  bindingGeneration: number;
}>;

/**
 * A release as read from storage or the wire. It has the full shape but has not been
 * checked against its approval, so `HarnessPort` does not accept it.
 */
export type UnverifiedReleasedJob = Readonly<{
  v: 1;
  releaseId: ReleaseId;
  approval: ReleaseApproval;
  binding: SessionBinding;
  policyVersion: number;
  events: readonly EventRef[];
  /** Opaque owner-local ledger handle, never a transferable fetch credential. */
  payloadRef: string;
  /** Digest of the exact ordered release payload bytes. */
  payloadDigest: string;
  causalRootId: CausalRootId;
}>;

declare const verifiedRelease: unique symbol;

/**
 * A release checked against its approval. Only `releaseFromApproval` and
 * `verifyReleasedJob` produce one; an object literal or decoded value does not
 * type-check as a `ReleasedJob`.
 */
export type ReleasedJob = UnverifiedReleasedJob & { readonly [verifiedRelease]: true };

/** Release-specific values chosen by the releaser, validated like wire input. */
export type ReleaseEnvelope = Readonly<{
  releaseId: ReleaseId;
  payloadRef: string;
  payloadDigest: string;
  causalRootId: CausalRootId;
}>;

export type ReleaseRejectionCode =
  | 'approval_mismatch'
  | 'binding_mismatch'
  | 'stale_binding'
  | 'stale_policy'
  | 'room_mismatch'
  | 'selection_mismatch'
  | 'stale_content'
  | 'invalid_field';

export type Released =
  | Readonly<{ ok: true; value: ReleasedJob }>
  | Readonly<{ ok: false; code: ReleaseRejectionCode; field: string }>;

type ReleaseInput = Readonly<{
  approval: ApprovalCommand;
  /** The exact events being released, in order. */
  items: readonly EventRef[];
  /** The recipient binding as it is now. */
  binding: SessionBinding;
  /** The policy version in effect now. */
  policyVersion: number;
  release: ReleaseEnvelope;
}>;

const reject = (code: ReleaseRejectionCode, field: string): Released => ({ ok: false, code, field });

/**
 * The only constructor of a `ReleasedJob`. Every item must equal the approved
 * selection entry at the same position (`sameEventRef`), and the binding, its
 * generation, the policy version and the room must be exactly those the owner
 * reviewed. Anything else is a typed rejection, never a partial release.
 */
export function releaseFromApproval(input: ReleaseInput): Released {
  const { approval, items, binding, policyVersion, release } = input;
  if (binding.bindingId !== approval.bindingId) return reject('binding_mismatch', 'binding.bindingId');
  if (binding.generation !== approval.expectedBindingGeneration) return reject('stale_binding', 'binding.generation');
  if (policyVersion !== approval.expectedPolicyVersion) return reject('stale_policy', 'policyVersion');
  if (items.length === 0 || items.length !== approval.selection.length) return reject('selection_mismatch', 'items');
  for (const [index, item] of items.entries()) {
    const approved = approval.selection[index]!;
    if (item.roomId !== approval.roomId) return reject('room_mismatch', `items[${index}].roomId`);
    if (!sameEventIdentity(item, approved)) return reject('selection_mismatch', `items[${index}]`);
    if (!sameEventRef(item, approved)) return reject('stale_content', `items[${index}]`);
  }

  const envelope = decodeWith(() => {
    const at = (key: keyof ReleaseEnvelope): string => `release.${key}`;
    return {
      releaseId: readId<'ReleaseId'>(release.releaseId, at('releaseId')),
      payloadRef: identifier(release.payloadRef, at('payloadRef')),
      payloadDigest: readSha256Digest(release.payloadDigest, at('payloadDigest')),
      causalRootId: readId<'CausalRootId'>(release.causalRootId, at('causalRootId')),
    };
  });
  if (!envelope.ok) return reject('invalid_field', envelope.field);

  const job: UnverifiedReleasedJob = {
    v: 1,
    releaseId: envelope.value.releaseId,
    approval: {
      commandId: approval.commandId,
      policyVersion: approval.expectedPolicyVersion,
      bindingGeneration: approval.expectedBindingGeneration,
    },
    binding,
    policyVersion,
    events: items,
    payloadRef: envelope.value.payloadRef,
    payloadDigest: envelope.value.payloadDigest,
    causalRootId: envelope.value.causalRootId,
  };
  return { ok: true, value: job as ReleasedJob };
}

/**
 * Re-verifies a stored or decoded release against the approval it records. The
 * caller supplies that approval from its own ledger, never from the same record.
 */
export function verifyReleasedJob(job: UnverifiedReleasedJob, approval: ApprovalCommand): Released {
  if (job.approval.commandId !== approval.commandId) return reject('approval_mismatch', 'approval.commandId');
  if (job.approval.policyVersion !== approval.expectedPolicyVersion) {
    return reject('approval_mismatch', 'approval.policyVersion');
  }
  if (job.approval.bindingGeneration !== approval.expectedBindingGeneration) {
    return reject('approval_mismatch', 'approval.bindingGeneration');
  }
  return releaseFromApproval({
    approval,
    items: job.events,
    binding: job.binding,
    policyVersion: job.policyVersion,
    release: {
      releaseId: job.releaseId,
      payloadRef: job.payloadRef,
      payloadDigest: job.payloadDigest,
      causalRootId: job.causalRootId,
    },
  });
}

/** Decodes wire or ledger bytes to an unverified release; see `verifyReleasedJob`. */
export function decodeReleasedJob(input: unknown, limits: DeliveryLimits): Decoded<UnverifiedReleasedJob> {
  return decodeWith(() => readReleasedJob(input, '', limits));
}

function readReleaseApproval(input: unknown, field: string): ReleaseApproval {
  const reader = object(input, field, ['commandId', 'policyVersion', 'bindingGeneration']);
  return {
    commandId: readId<'CommandId'>(reader.field('commandId'), reader.at('commandId')),
    policyVersion: safeInteger(reader.field('policyVersion'), reader.at('policyVersion')),
    bindingGeneration: safeInteger(reader.field('bindingGeneration'), reader.at('bindingGeneration')),
  };
}

function readReleasedJob(input: unknown, field: string, limits: DeliveryLimits): UnverifiedReleasedJob {
  const reader = object(input, field, [
    'v', 'releaseId', 'approval', 'binding', 'policyVersion', 'events', 'payloadRef', 'payloadDigest',
    'causalRootId',
  ]);
  const job: UnverifiedReleasedJob = {
    v: version(reader.field('v'), reader.at('v')),
    releaseId: readId<'ReleaseId'>(reader.field('releaseId'), reader.at('releaseId')),
    approval: readReleaseApproval(reader.field('approval'), reader.at('approval')),
    binding: readSessionBinding(reader.field('binding'), reader.at('binding')),
    policyVersion: safeInteger(reader.field('policyVersion'), reader.at('policyVersion')),
    events: readEventSelection(reader.field('events'), reader.at('events'), limits),
    payloadRef: identifier(reader.field('payloadRef'), reader.at('payloadRef')),
    payloadDigest: readSha256Digest(reader.field('payloadDigest'), reader.at('payloadDigest')),
    causalRootId: readId<'CausalRootId'>(reader.field('causalRootId'), reader.at('causalRootId')),
  };
  // Provenance must agree with the release it describes; `verifyReleasedJob` then
  // checks it against the approval itself.
  if (job.approval.policyVersion !== job.policyVersion) fail(`${reader.at('approval')}.policyVersion`, 'invalid_field');
  if (job.approval.bindingGeneration !== job.binding.generation) {
    fail(`${reader.at('approval')}.bindingGeneration`, 'invalid_field');
  }
  return job;
}

/**
 * Applies the configured byte limit before an adapter receives release payload
 * bytes. Digest verification belongs to KHA-121 because KHA-119 owns the future
 * canonical envelope codec.
 */
export function validatePayloadBytes(input: unknown, limits: DeliveryLimits): Decoded<Uint8Array> {
  return decodeWith(() => {
    if (!(input instanceof Uint8Array)) fail('payload', 'invalid_field');
    if (input.byteLength > limits.maxPayloadBytes) fail('payload', 'limit_exceeded');
    return input;
  });
}
