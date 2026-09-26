// Owner endpoint for human review. The protected control transport authenticates
// the human, derives `OwnerAuthority` from that session and hands it here with the
// untrusted request body. Nothing in a body is authority: an owner, binding or
// "approved" flag inside it is either refused by the strict decoder or ignored.
//
// An approval is validated, journalled and committed before anything can reach the
// dispatcher. Order per command:
//   1. decode the body and fingerprint it (KHA-119 `decisionFingerprint`);
//   2. replay the journalled outcome for this owner's command ID, if any;
//   3. evaluate against one ledger snapshot, the effective policy and room membership;
//   4. commit command outcome, payload and job together (`putRelease`);
//   5. hand the committed job to the dispatcher.
// A crash before 4 leaves nothing eligible. A crash between 4 and 5 is repaired by
// `resumeReleases`, which re-enqueues the same release by its durable identity.

import {
  type ApprovalCommand, type ApprovalResult, type BindingId, type CausalRootId, type DeliveryLimits,
  type OperationId, type OwnerAuthority, type ParticipantId, type ReleaseId, type RoomId,
  type UnverifiedReleasedJob, decodeApprovalCommand,
} from '@khala/contracts/delivery/index';
import type { EnqueueResult } from '@khala/connector/dispatch/types';
import type { ConnectorStorage } from '@khala/connector/storage/open';
import type { ConnectorDispatchStorage } from '@khala/connector/storage/dispatch';
import type { CommandRecord, ReleaseConflictCode, ReleaseResult } from '@khala/connector/storage/ledger';
import { newPayloadRef } from '@khala/connector/storage/payloads';
import { recoverConnectorStorage } from '@khala/connector/storage/recovery';
import { evaluateApproval } from '@khala/policy/release/evaluate';
import { decisionFingerprint } from '@khala/policy/release/handoff';
import {
  type EffectivePolicy, type PreviewOutcome, decodePreviewRequest, readPreview, toReleasePending,
} from './preview-access';

/** Trusted room membership as the connector's own messaging subscription observed it. */
export interface ReviewRoomPort {
  /** Current member participant IDs, or null when membership cannot be read now. */
  members(roomId: RoomId): Promise<readonly ParticipantId[] | null>;
}

/** The dispatcher's intake. Enqueueing the same release twice is `duplicate`, never a second job. */
export interface ReviewReleaseSink {
  enqueue(job: UnverifiedReleasedJob): Promise<EnqueueResult>;
}

export type ReviewControlDependencies = Readonly<{
  storage: ConnectorStorage;
  dispatchStorage: Pick<ConnectorDispatchStorage, 'ledger'>;
  releases: ReviewReleaseSink;
  room: ReviewRoomPort;
  limits: DeliveryLimits;
  /** When set, only this runtime's binding is served; every other binding reads as forbidden. */
  bindingId?: BindingId;
  /** Fresh releaser-chosen identifiers. Defaults to random UUIDs. */
  newReleaseId?: () => string;
  /** Called with a content-free code when a background step fails; never with a payload. */
  onError?: (code: 'enqueue_failed' | 'resume_failed') => void;
}>;

/**
 * The restricted control surface. It is registered only on the protected human
 * transport and is never part of a model tool, MCP server or notification set.
 */
export interface ReviewControlHandler {
  approve(authority: OwnerAuthority, input: unknown): Promise<ApprovalResult>;
  preview(authority: OwnerAuthority, input: unknown): Promise<PreviewOutcome>;
  /** Re-enqueues committed releases for `bindingId` that never reached the dispatcher. */
  resumeReleases(bindingId: BindingId): Promise<void>;
}

const MAX_STALE_LEDGER_ATTEMPTS = 3;

const refuse = (code: Exclude<ApprovalResult, { ok: true }>['code'] & string): ApprovalResult =>
  ({ ok: false, code } as ApprovalResult);

const CONFLICTS: Readonly<Record<Exclude<ReleaseConflictCode, 'stale_ledger'>, ApprovalResult>> = {
  idempotency_conflict: refuse('idempotency_conflict'),
  revoked: refuse('forbidden'),
  stale_binding: refuse('stale_binding'),
  pending_missing: refuse('expired_content'),
  stale_content: refuse('stale_content'),
  already_released: refuse('stale_content'),
  command_mismatch: refuse('unavailable'),
  invalid_command_result: refuse('unavailable'),
  payload_digest_mismatch: refuse('unavailable'),
  limit_exceeded: refuse('unavailable'),
  release_conflict: refuse('unavailable'),
};

type Attempt =
  | Readonly<{ kind: 'done'; result: ApprovalResult; job?: UnverifiedReleasedJob }>
  | Readonly<{ kind: 'retry' }>;

export function createReviewControlHandler(deps: ReviewControlDependencies): ReviewControlHandler {
  const newReleaseId = deps.newReleaseId ?? (() => `release_${crypto.randomUUID()}`);

  async function effectivePolicy(bindingId: BindingId): Promise<EffectivePolicy | null> {
    return deps.dispatchStorage.ledger.transact(tx => {
      const state = tx.binding(bindingId);
      const policy = tx.policy(bindingId);
      if (state === null || state.revoked || policy === null) return null;
      return { generation: state.binding.generation, version: policy.version };
    });
  }

  async function enqueue(job: UnverifiedReleasedJob): Promise<void> {
    try {
      await deps.releases.enqueue(job);
    } catch {
      // The release is durable. `resumeReleases` hands it over again after restart.
      deps.onError?.('enqueue_failed');
    }
  }

  /** Replays a committed outcome and makes sure its release reached the dispatcher. */
  async function replay(record: CommandRecord, inputDigest: string): Promise<ApprovalResult> {
    if (record.inputDigest !== inputDigest) return refuse('idempotency_conflict');
    if (record.result.ok) {
      const jobs = await deps.storage.ledger.transaction(tx =>
        record.result.ok ? record.result.releaseIds.map(id => tx.readRelease(id)?.job ?? null) : []);
      for (const job of jobs) if (job !== null) await enqueue(job);
    }
    return record.result;
  }

  async function attempt(
    authority: OwnerAuthority,
    command: ApprovalCommand,
    inputDigest: string,
  ): Promise<Attempt> {
    const [effective, members] = await Promise.all([
      effectivePolicy(command.bindingId),
      deps.room.members(command.roomId),
    ]);

    const read = await deps.storage.ledger.transaction(tx => {
      const journalled = tx.readCommand(authority.ownerId, command.commandId);
      if (journalled !== null) return { kind: 'journalled', record: journalled } as const;
      // The owner check precedes every pending read, so another owner learns nothing.
      const binding = tx.readBinding(command.bindingId);
      if (binding === null) return { kind: 'refused', result: refuse('stale_binding') } as const;
      if (binding.ownerId !== authority.ownerId) return { kind: 'refused', result: refuse('forbidden') } as const;
      const snapshot = tx.readApprovalSnapshot({ bindingId: command.bindingId, selection: command.selection });
      if (snapshot === null) return { kind: 'refused', result: refuse('stale_binding') } as const;
      if (snapshot.kind === 'revoked') return { kind: 'refused', result: refuse('forbidden') } as const;
      return { kind: 'snapshot', snapshot } as const;
    });
    if (read.kind === 'journalled') return { kind: 'done', result: await replay(read.record, inputDigest) };
    if (read.kind === 'refused') return { kind: 'done', result: read.result };

    const { snapshot } = read;
    if (members === null) return { kind: 'done', result: refuse('unavailable') };
    if (effective === null || effective.generation !== snapshot.binding.generation) {
      // Without an applied policy for this exact generation nothing may be released.
      return { kind: 'done', result: refuse(effective === null ? 'unavailable' : 'stale_binding') };
    }

    const releaseId = newReleaseId() as ReleaseId;
    const evaluation = await evaluateApproval({
      authority,
      command,
      binding: snapshot.binding,
      policyVersion: effective.version,
      room: { roomId: command.roomId, members },
      pending: snapshot.pending.map(toReleasePending),
      release: { releaseId, payloadRef: newPayloadRef(), causalRootId: releaseId as string as CausalRootId },
    });
    if (!evaluation.ok) return { kind: 'done', result: refuse(evaluation.code) };

    const { decision } = evaluation;
    const result: ApprovalResult = { ok: true, releaseIds: [decision.releaseId] };
    let committed: ReleaseResult;
    try {
      committed = await deps.storage.ledger.transaction(tx => tx.putRelease({
        command: { ownerId: authority.ownerId, commandId: command.commandId, inputDigest, command, result },
        job: decision.job,
        payload: decision.payload,
        expectedLedgerRevision: snapshot.ledgerRevision,
      }));
    } catch {
      // The commit may or may not have landed. The journal answers a retry of the
      // same command ID; nothing here may mint a second release for it.
      return {
        kind: 'done',
        result: { ok: false, code: 'outcome_unknown', operationId: command.commandId as string as OperationId },
      };
    }
    if (committed.kind !== 'conflict') {
      if (committed.kind === 'committed') return { kind: 'done', result, job: decision.job };
      const record = await deps.storage.ledger.transaction(tx => tx.readCommand(authority.ownerId, command.commandId));
      return { kind: 'done', result: record === null ? refuse('unavailable') : await replay(record, inputDigest) };
    }
    if (committed.code === 'stale_ledger') return { kind: 'retry' };
    return { kind: 'done', result: CONFLICTS[committed.code] };
  }

  async function approve(authority: OwnerAuthority, input: unknown): Promise<ApprovalResult> {
    const decoded = decodeApprovalCommand(input, deps.limits);
    if (!decoded.ok) return refuse('forbidden');
    const command = decoded.value;
    if (deps.bindingId !== undefined && command.bindingId !== deps.bindingId) return refuse('forbidden');
    const fingerprint = await decisionFingerprint(command);
    if (!fingerprint.ok) return refuse('unavailable');
    try {
      for (let index = 0; index < MAX_STALE_LEDGER_ATTEMPTS; index += 1) {
        const outcome = await attempt(authority, command, fingerprint.digest);
        if (outcome.kind === 'retry') continue;
        if (outcome.job) await enqueue(outcome.job);
        return outcome.result;
      }
    } catch {
      // Reads failed before any commit was attempted: definitely nothing was written.
      return refuse('unavailable');
    }
    return refuse('unavailable');
  }

  async function preview(authority: OwnerAuthority, input: unknown): Promise<PreviewOutcome> {
    const request = decodePreviewRequest(input, deps.limits);
    if (request === null || (deps.bindingId !== undefined && request.bindingId !== deps.bindingId)) {
      return { ok: false, code: 'forbidden' };
    }
    try {
      const effective = await effectivePolicy(request.bindingId);
      return await deps.storage.ledger.transaction(tx => readPreview(tx, authority, request, effective));
    } catch {
      return { ok: false, code: 'unavailable' };
    }
  }

  async function resumeReleases(bindingId: BindingId): Promise<void> {
    try {
      const report = await recoverConnectorStorage(deps.storage);
      const jobs = await deps.storage.ledger.transaction(tx => report.undispatchedReleases.flatMap(id => {
        const release = tx.readRelease(id);
        return release !== null && release.job.binding.bindingId === bindingId ? [release.job] : [];
      }));
      for (const job of jobs) await enqueue(job);
    } catch {
      deps.onError?.('resume_failed');
    }
  }

  return { approve, preview, resumeReleases };
}
