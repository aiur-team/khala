// Owner endpoint for trust, pause and status. The protected control transport
// authenticates the human, derives `OwnerAuthority` from that session and hands it
// here with the untrusted request body. Nothing in a body is authority.
//
// A policy change moves through three durable steps:
//   1. KHA-120 `evaluatePolicyChange` accepts it against the stored trust state
//      (owner, binding generation and policy version compare-and-set) and journals it;
//   2. `applyEffectivePolicy` commits the revision to the dispatch ledger. That commit
//      is the serialization point: every claim after it sees the new version and pause;
//   3. the ledger's answer becomes a `PolicyAck` that `applyPolicyAck` records.
// Only step 2 makes a request effective. A crash after 1 leaves a requested revision
// that the next command, or a retry of the same command ID, enforces before anything
// else. Hosted `auto` is refused at step 1 (`CLOSED_AUTOMATION`, G-AUTOMATION).

import {
  type BindingId, type HarnessCapabilities, type OwnerAuthority, type PolicyAck, type PolicyAckErrorCode,
  type RoomId, type SessionBinding, decodeBindingId, decodePolicySetCommand,
} from '@khala/contracts/delivery/index';
import type { DispatchPolicy } from '@khala/connector/dispatch/types';
import type { ConnectorDispatchStorage, EffectivePolicyWriteResult } from '@khala/connector/storage/dispatch';
import {
  type PolicyChangeRejection, type PolicyRevision, type TrustState, applyPolicyAck, initialTrustState,
} from '@khala/policy/trust/index';
import { evaluateHostedPolicyChange } from './automation';
import { type ControlsStatus, observeStatus, policyStatus } from './status-observer';

/**
 * Durable trust state per binding (KHA-120 leaves storage to this composition). `update`
 * runs `work` against the stored state and commits what it returns, atomically against
 * every other update of the same binding. If `work` throws, nothing is committed.
 */
export interface TrustStateStore {
  read(bindingId: BindingId): Promise<TrustState | null>;
  update<T>(
    bindingId: BindingId,
    work: (current: TrustState | null) => Readonly<{ next: TrustState; result: T }>,
  ): Promise<T>;
}

export type PolicyControlDependencies = Readonly<{
  dispatchStorage: Pick<ConnectorDispatchStorage, 'ledger' | 'applyEffectivePolicy'>;
  trust: TrustStateStore;
  /** The room this connector's binding serves, from trusted composition. */
  roomId: RoomId;
  /** When set, only this runtime's binding is served; every other binding reads as forbidden. */
  bindingId?: BindingId;
  /** The bound route's inspected capability record, or null when not inspected. */
  capabilities?: () => HarnessCapabilities | null;
}>;

export type PolicyControlResult =
  | Readonly<{ ok: true; ack: PolicyAck }>
  /** The body is not a policy command for this connector, or the caller does not own it. */
  | Readonly<{ ok: false; code: 'forbidden' }>;

export type ControlsStatusResult =
  | Readonly<{ ok: true; status: ControlsStatus }>
  | Readonly<{ ok: false; code: 'forbidden' | 'unavailable' }>;

/**
 * The restricted control surface. It is registered only on the protected human
 * transport and is never part of a model tool, MCP server or notification set.
 */
export interface PolicyControlHandler {
  setPolicy(authority: OwnerAuthority, input: unknown): Promise<PolicyControlResult>;
  status(authority: OwnerAuthority, input: unknown): Promise<ControlsStatusResult>;
  /** Enforces a request that was accepted but never reached the ledger. */
  reconcile(bindingId: BindingId): Promise<void>;
}

const REJECTIONS: Readonly<Record<PolicyChangeRejection, PolicyAckErrorCode>> = {
  forbidden: 'forbidden',
  binding_mismatch: 'forbidden',
  binding_revoked: 'forbidden',
  stale_binding: 'stale_binding',
  stale_policy: 'stale_policy',
  idempotency_conflict: 'idempotency_conflict',
  // Not an owner mistake: the hosted product has no approved automation yet.
  automation_gated: 'unavailable',
};

type WriteConflict = Extract<EffectivePolicyWriteResult, { kind: 'conflict' }>['code'];

const WRITE_CONFLICTS: Readonly<Record<WriteConflict, PolicyAckErrorCode>> = {
  binding_unknown: 'stale_binding',
  binding_mismatch: 'stale_binding',
  revoked: 'forbidden',
  stale_version: 'stale_policy',
  version_conflict: 'stale_policy',
};

type LedgerView = Readonly<{
  binding: SessionBinding;
  revoked: boolean;
  policy: DispatchPolicy | null;
}>;

/** Enforcement outcome of one revision. */
type Enforcement =
  | Readonly<{ kind: 'effective' }>
  | Readonly<{ kind: 'rejected'; code: PolicyAckErrorCode }>
  | Readonly<{ kind: 'unknown' }>;

export function createPolicyControlHandler(deps: PolicyControlDependencies): PolicyControlHandler {
  const { dispatchStorage, trust } = deps;

  async function readLedger(bindingId: BindingId): Promise<LedgerView | null> {
    return dispatchStorage.ledger.transact(tx => {
      const state = tx.binding(bindingId);
      return state === null ? null : { binding: state.binding, revoked: state.revoked, policy: tx.policy(bindingId) };
    });
  }

  /**
   * Trust state for the ledger's current generation. A missing state, or one for an
   * older generation, starts again from what the ledger enforces: trust is never
   * inherited across generations, and the ledger version stays the compare-and-set value.
   */
  function baseline(current: TrustState | null, ledger: LedgerView & { policy: DispatchPolicy }): TrustState {
    if (current !== null && current.generation === ledger.binding.generation) return current;
    const fresh = initialTrustState({
      roomId: deps.roomId,
      bindingId: ledger.binding.bindingId,
      ownerId: ledger.binding.ownerId,
      generation: ledger.binding.generation,
      policyVersion: ledger.policy.version,
    });
    const revision = { ...fresh.requested, paused: ledger.policy.paused };
    return { ...fresh, requested: revision, effective: revision };
  }

  /** Commits one revision at the dispatcher's serialization point. */
  async function enforce(
    ledger: LedgerView & { policy: DispatchPolicy },
    state: TrustState,
    revision: PolicyRevision,
  ): Promise<Enforcement> {
    const enforced = ledger.policy;
    if (enforced.version === revision.version) {
      // Already committed, for example before a crash lost the acknowledgment.
      return enforced.paused === revision.paused ? { kind: 'effective' } : { kind: 'rejected', code: 'stale_policy' };
    }
    if (enforced.version > revision.version) return { kind: 'rejected', code: 'stale_policy' };
    const previous = state.effective;
    // A new mode, or a new peer for `auto`, re-arms: releases approved under older revisions stop
    // being current. Review releases name their own approval, so the peer does not re-arm review.
    // Pause and resume keep them, so resuming continues exactly what was approved.
    const rearmed = previous === null || previous.mode !== revision.mode
      || (revision.mode === 'auto' && previous.peerParticipantId !== revision.peerParticipantId);
    const policy: DispatchPolicy = {
      version: revision.version,
      armedAt: rearmed ? revision.version : enforced.armedAt,
      paused: revision.paused,
      expiresAt: enforced.expiresAt,
      listening: enforced.listening,
    };
    let written: EffectivePolicyWriteResult;
    try {
      written = await dispatchStorage.applyEffectivePolicy({ binding: ledger.binding, policy });
    } catch {
      // The write may have committed. The same revision is enforced again on retry.
      return { kind: 'unknown' };
    }
    return written.kind === 'conflict' ? { kind: 'rejected', code: WRITE_CONFLICTS[written.code] } : { kind: 'effective' };
  }

  function ackFor(binding: SessionBinding, revision: PolicyRevision, enforcement: Enforcement): PolicyAck {
    const base = {
      v: 1 as const,
      commandId: revision.commandId!,
      bindingId: binding.bindingId,
      generation: binding.generation,
      requestedVersion: revision.version,
    };
    if (enforcement.kind === 'effective') {
      return { ...base, effectiveVersion: revision.version, connectorState: 'effective', errorCode: null };
    }
    if (enforcement.kind === 'unknown') {
      return { ...base, effectiveVersion: null, connectorState: 'pending', errorCode: 'outcome_unknown' };
    }
    return { ...base, effectiveVersion: null, connectorState: 'rejected', errorCode: enforcement.code };
  }

  async function record(bindingId: BindingId, ack: PolicyAck): Promise<void> {
    await trust.update(bindingId, current => {
      if (current === null) throw new Error('trust state missing');
      return { next: applyPolicyAck(current, ack).state, result: undefined };
    });
  }

  /** Enforces the newest accepted request if the ledger has not committed it yet. */
  async function settle(ledger: LedgerView & { policy: DispatchPolicy }): Promise<TrustState> {
    const state = await trust.update(ledger.binding.bindingId, current => {
      const next = baseline(current, ledger);
      return { next, result: next };
    });
    const revision = state.requested;
    if (revision.commandId === null || state.effective?.version === revision.version) return state;
    const enforcement = await enforce(ledger, state, revision);
    await record(ledger.binding.bindingId, ackFor(ledger.binding, revision, enforcement));
    return (await trust.read(ledger.binding.bindingId)) ?? state;
  }

  async function usableLedger(bindingId: BindingId): Promise<(LedgerView & { policy: DispatchPolicy }) | null> {
    const ledger = await readLedger(bindingId);
    return ledger !== null && !ledger.revoked && ledger.policy !== null ? { ...ledger, policy: ledger.policy } : null;
  }

  async function setPolicy(authority: OwnerAuthority, input: unknown): Promise<PolicyControlResult> {
    const decoded = decodePolicySetCommand(input);
    if (!decoded.ok) return { ok: false, code: 'forbidden' };
    const command = decoded.value;
    if (deps.bindingId !== undefined && command.bindingId !== deps.bindingId) return { ok: false, code: 'forbidden' };

    const refused = (errorCode: PolicyAckErrorCode, generation: number, effectiveVersion: number | null): PolicyControlResult => ({
      ok: true,
      ack: {
        v: 1, commandId: command.commandId, bindingId: command.bindingId, generation,
        requestedVersion: null, effectiveVersion, connectorState: 'rejected', errorCode,
      },
    });

    let ledger: LedgerView | null;
    try {
      ledger = await readLedger(command.bindingId);
    } catch {
      // Nothing has been written for this command yet.
      return refused('unavailable', command.expectedBindingGeneration, null);
    }
    // The owner check precedes every other answer, so another owner learns nothing.
    if (ledger === null) return { ok: false, code: 'forbidden' };
    if (ledger.binding.ownerId !== authority.ownerId) return { ok: false, code: 'forbidden' };
    if (ledger.revoked) return refused('forbidden', ledger.binding.generation, null);
    if (ledger.policy === null) return refused('unavailable', ledger.binding.generation, null);
    const usable = { ...ledger, policy: ledger.policy };

    try {
      // An earlier accepted request is enforced before this one is compared against it.
      await settle(usable);
      const change = await trust.update(command.bindingId, current => {
        const evaluated = evaluateHostedPolicyChange(baseline(current, usable), { kind: 'owner', authority }, command, 'active');
        return { next: evaluated.state, result: evaluated };
      });
      if (!change.outcome.ok) {
        return refused(REJECTIONS[change.outcome.code], ledger.binding.generation, change.state.effective?.version ?? null);
      }
      const revision = change.outcome.requested;
      if (change.state.effective?.version === revision.version) {
        // A retry of a command that is already enforced.
        return { ok: true, ack: ackFor(ledger.binding, revision, { kind: 'effective' }) };
      }
      if (revision.version !== change.state.requested.version) {
        // A retry of a command a newer request superseded before it was enforced.
        return { ok: true, ack: ackFor(ledger.binding, revision, { kind: 'rejected', code: 'stale_policy' }) };
      }
      // Re-read: `settle` may have moved the ledger since the first read.
      const current = await usableLedger(command.bindingId);
      if (current === null || current.binding.generation !== revision.generation) {
        return { ok: true, ack: ackFor(ledger.binding, revision, { kind: 'rejected', code: 'stale_binding' }) };
      }
      const enforcement = await enforce(current, change.state, revision);
      const ack = ackFor(current.binding, revision, enforcement);
      await record(command.bindingId, ack).catch(() => undefined);
      return { ok: true, ack };
    } catch {
      // Trust state or the ledger failed after the command may have been journalled.
      return {
        ok: true,
        ack: {
          v: 1, commandId: command.commandId, bindingId: command.bindingId, generation: ledger.binding.generation,
          requestedVersion: null, effectiveVersion: null, connectorState: 'pending', errorCode: 'outcome_unknown',
        },
      };
    }
  }

  async function status(authority: OwnerAuthority, input: unknown): Promise<ControlsStatusResult> {
    const request = input as { bindingId?: unknown } | null;
    const decoded = typeof request === 'object' && request !== null && Object.keys(request).length === 1
      ? decodeBindingId(request.bindingId)
      : null;
    if (decoded === null || !decoded.ok) return { ok: false, code: 'forbidden' };
    const bindingId = decoded.value;
    if (deps.bindingId !== undefined && bindingId !== deps.bindingId) return { ok: false, code: 'forbidden' };
    try {
      const observed = await dispatchStorage.ledger.transact(tx => {
        const state = tx.binding(bindingId);
        if (state === null || state.binding.ownerId !== authority.ownerId) return null;
        return observeStatus(tx, state.binding, state.revoked);
      });
      if (observed === null) return { ok: false, code: 'forbidden' };
      const stored = await trust.read(bindingId);
      const { enforced, ...rest } = observed;
      return {
        ok: true,
        status: {
          ...rest,
          capabilities: deps.capabilities?.() ?? null,
          ...policyStatus(observed.binding, enforced, stored),
        },
      };
    } catch {
      return { ok: false, code: 'unavailable' };
    }
  }

  async function reconcile(bindingId: BindingId): Promise<void> {
    const ledger = await usableLedger(bindingId);
    if (ledger !== null) await settle(ledger);
  }

  return { setPolicy, status, reconcile };
}
