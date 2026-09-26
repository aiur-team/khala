import type { BindingId, ReleaseId } from '@khala/contracts/delivery/index';
import type { RecoveryReport } from '@khala/connector/storage/recovery';
import { describe, expect, it } from 'vitest';
import { binding } from '../../../../../packages/connector/src/storage/fixtures/fakes';
import { reconcileRestoredLedger } from './reconcile';

const clean: RecoveryReport = {
  schemaVersion: 1, epoch: 2, ledgerRevision: 9, deviceIdentityBound: true, pending: 1, staleGenerationPending: 0,
  quarantined: 0, outcomeUnknownReleases: ['release_r7' as ReleaseId], undispatchedReleases: ['release_r8' as ReleaseId],
  unavailable: 0, revokedBindings: [], uncorrelatedReceipts: 0, cursors: [], blocked: [],
};

describe('reconcileRestoredLedger', () => {
  it('holds every release with dispatch evidence and allows the rest to the dispatcher', () => {
    expect(reconcileRestoredLedger(clean, binding(0), 0)).toEqual({
      dispatch: 'allowed', reasons: [], heldReleaseIds: ['release_r7'], undispatchedReleases: 1, staleGenerationPending: 0, quarantined: 0,
    });
  });

  it('blocks on a damaged ledger, a revoked binding or a newer ledger generation', () => {
    const blocked = reconcileRestoredLedger(
      { ...clean, blocked: ['integrity_failed', 'payload_damaged', 'revoked'], revokedBindings: [binding(0).bindingId] },
      binding(0),
      1,
    );
    expect(blocked).toMatchObject({
      dispatch: 'blocked', reasons: ['integrity_failed', 'payload_damaged', 'binding_revoked', 'stale_generation'],
      heldReleaseIds: ['release_r7'],
    });
  });

  it('does not block this binding for another binding’s revocation or an unresolved quarantine', () => {
    const report = { ...clean, blocked: ['revoked', 'quarantine_unresolved'] as const, revokedBindings: ['binding_other' as BindingId], quarantined: 2 };
    expect(reconcileRestoredLedger(report, binding(1), 0)).toMatchObject({ dispatch: 'allowed', quarantined: 2 });
  });
});
