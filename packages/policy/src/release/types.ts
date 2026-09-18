// Inputs and outcomes of exact approval release. Every input is supplied by trusted
// composition; this module reads no SDK, history or storage itself.

import type {
  ApprovalCommand, ApprovalErrorCode, CausalRootId, CommandId, EventRef, OwnerAuthority, ParticipantId, ReleaseId,
  ReleasedJob, RoomId, SessionBinding,
} from '@khala/contracts/delivery/index';

/**
 * Version 1 text content, mirroring the KHA-105 `MessageContent` shape without
 * importing the messaging domain. `contentDigest` covers its KHA-105 encoding.
 */
export type ReleaseContent = Readonly<{ v: 1; kind: 'text'; body: string }>;

/** Placeholder for a pending event whose plaintext cannot be shown (KHA-105 shape). */
export type UnavailableReleaseContent = Readonly<{ v: 1; kind: 'unavailable'; reason: string }>;

/**
 * One pending event exactly as the owner connector decrypted it. Deleted events
 * are omitted; redacted or undecryptable ones are omitted or carry `unavailable`
 * content. Either way there are no bytes to release.
 */
export type PendingRecord = Readonly<{ ref: EventRef; content: ReleaseContent | UnavailableReleaseContent }>;

/** Current membership of the room the command names, as trusted composition observed it. */
export type RoomScope = Readonly<{
  roomId: RoomId;
  members: readonly ParticipantId[];
}>;

/** Release identifiers chosen by the releaser (KHA-134), validated like wire input. */
export type ReleaseIdentity = Readonly<{
  releaseId: ReleaseId;
  /** Connector-local opaque ledger key, resolved only by the ledger; never a URL or filesystem path. */
  payloadRef: string;
  causalRootId: CausalRootId;
}>;

export type EvaluateInput = Readonly<{
  /** Verified by composition; a browser body never becomes authority. */
  authority: OwnerAuthority;
  command: ApprovalCommand;
  /** The recipient binding as it is now. */
  binding: SessionBinding;
  /** The effective policy version for this binding now. */
  policyVersion: number;
  room: RoomScope;
  /** The trusted pending snapshot. Unselected records are never released. */
  pending: readonly PendingRecord[];
  release: ReleaseIdentity;
}>;

/**
 * Why a command was refused. `code` is the `ApprovalResult` code the ledger
 * reports; `reason` is the finer audit reason. Neither carries message text.
 */
export type RejectionReason =
  | 'owner_mismatch'
  | 'room_mismatch'
  | 'recipient_not_member'
  | 'author_not_member'
  | 'invalid_selection'
  | 'binding_mismatch'
  | 'stale_binding'
  | 'stale_policy'
  | 'missing_content'
  | 'content_mismatch'
  | 'digest_mismatch'
  | 'unsupported_content'
  | 'invalid_release'
  | 'crypto_unavailable'
  | 'invalid_input';

export type ReleaseRejectionCode = Exclude<ApprovalErrorCode, 'idempotency_conflict' | 'outcome_unknown'>;

export type ReleaseRejection = Readonly<{
  ok: false;
  code: ReleaseRejectionCode;
  reason: RejectionReason;
  /** Location of the refused input, e.g. `command.selection[1]`. Never a value. */
  field: string;
}>;

export type ReleaseDecision = Readonly<{
  commandId: CommandId;
  releaseId: ReleaseId;
  /**
   * `decisionFingerprint(command)`. The KHA-134 journal stores it with the
   * committed result; a retry whose fingerprint differs is a conflict.
   */
  fingerprint: string;
  /** The verified release; `job.payloadDigest` digests `payload`. */
  job: ReleasedJob;
  /**
   * Canonical release bytes for the connector-local ledger. They contain the
   * selected plaintext, so they must never be logged, traced or put in an error.
   */
  payload: Uint8Array;
}>;

export type Evaluation = Readonly<{ ok: true; decision: ReleaseDecision }> | ReleaseRejection;
