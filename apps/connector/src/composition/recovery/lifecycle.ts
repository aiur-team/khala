// Owner-runtime recovery lifecycle (KHA-136). Order follows the approved policy: the
// restored ledger is reconciled first, unknown outcomes stay held, and only then may
// local cleanup run. Cleanup is local only (P13): it never recalls released content or
// another participant's copy.

import type { ReleaseId, SessionBinding } from '@khala/contracts/delivery/index';
import type { Dispatcher } from '@khala/connector/dispatch/types';
import type { RetentionReport } from '@khala/connector/retention/index';
import type { ConnectorStorage } from '@khala/connector/storage/open';
import { type RecoveryReport, recoverConnectorStorage } from '@khala/connector/storage/recovery';
import { type RestoreBlockReason, type RestoreReconciliation, reconcileRestoredLedger } from './reconcile';

export type RecoveryLifecycleDeps = Readonly<{
  binding: SessionBinding;
  /** `recoverConnectorStorage` over the opened ledger. Reports only; never repairs. */
  inspect(): Promise<RecoveryReport>;
  /** The generation the ledger records for `binding.bindingId`, or null when it has none. */
  ledgerGeneration(): Promise<number | null>;
  /**
   * Asks the dispatcher for external evidence about one held release. It must never requeue a
   * release that has dispatch evidence (`Dispatcher.reconcile` guarantees this).
   */
  reconcileRelease(releaseId: ReleaseId): Promise<void>;
  /** One bounded, resumable `sweepRetention` call under the owner's approved policy. */
  sweep?(): Promise<RetentionReport>;
}>;

/** Binds the lifecycle to the opened connector ledger and the running dispatcher. */
export function storageRecoveryDeps(
  input: Readonly<{ storage: ConnectorStorage; dispatcher: Pick<Dispatcher, 'reconcile'>; bindingId: SessionBinding['bindingId'] }>,
): Omit<RecoveryLifecycleDeps, 'binding' | 'sweep'> {
  return {
    inspect: () => recoverConnectorStorage(input.storage),
    ledgerGeneration: () => input.storage.ledger.transaction(tx => tx.readBinding(input.bindingId)?.generation ?? null),
    reconcileRelease: releaseId => input.dispatcher.reconcile(releaseId),
  };
}

export type RecoveryLifecycleState = 'idle' | 'inspecting' | 'ready' | 'blocked' | 'unavailable';

/**
 * Owner-facing presentation of the lifecycle. Release IDs are identities only: never content,
 * and nothing here is a model-facing hint.
 */
export type RecoveryObservation = Readonly<{
  state: RecoveryLifecycleState;
  reasons: readonly RestoreBlockReason[];
  unknownReleaseIds: readonly ReleaseId[];
  undispatchedReleases: number;
  staleGenerationPending: number;
  cleanup: RetentionReport['outcome'] | 'not_configured' | 'not_run' | 'failed';
}>;

export type CleanupResult =
  | Readonly<{ kind: 'swept'; report: RetentionReport }>
  | Readonly<{ kind: 'not_reconciled' | 'not_configured' | 'failed' | 'stopped' }>;

export interface RecoveryLifecycle {
  /** Inspects and reconciles once. A later `stop` discards any result still in flight. */
  start(): Promise<void>;
  stop(): void;
  observe(): RecoveryObservation;
  /** Local cleanup. Allowed only after this generation reconciled, even when dispatch is blocked. */
  cleanup(): Promise<CleanupResult>;
}

export function bindRecoveryLifecycle(deps: RecoveryLifecycleDeps): RecoveryLifecycle {
  let generation = 0;
  let state: RecoveryLifecycleState = 'idle';
  let reconciliation: RestoreReconciliation | null = null;
  let cleanup: RecoveryObservation['cleanup'] = deps.sweep ? 'not_run' : 'not_configured';

  const settle = (next: RecoveryLifecycleState, result: RestoreReconciliation | null) => {
    state = next;
    reconciliation = result;
  };

  return {
    async start() {
      const own = ++generation;
      settle('inspecting', null);
      let result: RestoreReconciliation;
      try {
        const [report, ledgerGeneration] = await Promise.all([deps.inspect(), deps.ledgerGeneration()]);
        if (own !== generation) return;
        result = reconcileRestoredLedger(report, deps.binding, ledgerGeneration);
        // Evidence only: a held release stays held whatever the harness answers.
        for (const releaseId of result.heldReleaseIds) {
          await deps.reconcileRelease(releaseId);
          if (own !== generation) return;
        }
      } catch {
        if (own === generation) settle('unavailable', null);
        return;
      }
      settle(result.dispatch === 'allowed' ? 'ready' : 'blocked', result);
    },

    stop() {
      generation += 1;
      settle('idle', null);
    },

    observe() {
      return {
        state,
        reasons: reconciliation?.reasons ?? [],
        unknownReleaseIds: reconciliation?.heldReleaseIds ?? [],
        undispatchedReleases: reconciliation?.undispatchedReleases ?? 0,
        staleGenerationPending: reconciliation?.staleGenerationPending ?? 0,
        cleanup,
      };
    },

    async cleanup() {
      if (!deps.sweep) return { kind: 'not_configured' };
      if (state !== 'ready' && state !== 'blocked') return { kind: 'not_reconciled' };
      const own = generation;
      let report: RetentionReport;
      try {
        report = await deps.sweep();
      } catch {
        if (own !== generation) return { kind: 'stopped' };
        cleanup = 'failed';
        return { kind: 'failed' };
      }
      if (own !== generation) return { kind: 'stopped' };
      cleanup = report.outcome;
      return { kind: 'swept', report };
    },
  };
}
