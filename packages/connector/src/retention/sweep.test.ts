// U2/U3: the sweep against the in-memory ledger fake, including races between
// deletion and approval or dispatch. Passing proves module behaviour against the
// port contract, not the KHA-115 ledger or any SDK.

import type { EventId } from '@khala/contracts/delivery/ids';
import { describe, expect, it } from 'vitest';
import type { RetentionPolicy, RetentionRecord } from './eligibility';
import { memoryLedger } from './fakes';
import { RETENTION_LIMITS } from './report';
import { type RetentionPorts, type SweepInput, sweepRetention } from './sweep';

const policy: RetentionPolicy = {
  version: 3,
  evaluatedAt: '2026-09-18T11:00:00Z',
  pendingBefore: '2026-09-10T00:00:00Z',
  releasedBefore: '2026-09-10T00:00:00Z',
  allowPendingDeletion: true,
  dedupBefore: null,
};

type Seed = Omit<RetentionRecord, 'revision' | 'eventId' | 'receivedAt' | 'releasedAt' | 'tombstonedAt' | 'backupHold'>
  & Partial<RetentionRecord>;

function setup(seeds: readonly Seed[], version = policy.version) {
  const ledger = memoryLedger(version);
  for (const seed of seeds) {
    ledger.add({
      eventId: `$${seed.recordId}` as EventId,
      receivedAt: '2026-09-01T00:00:00Z',
      releasedAt: seed.state === 'released' ? '2026-09-02T00:00:00Z' : null,
      tombstonedAt: null,
      backupHold: false,
      ...seed,
    });
  }
  const ports: RetentionPorts = {
    records: ledger.records, claims: ledger.claimPort, crypto: ledger.crypto, clock: { now: () => ledger.now },
  };
  const sweep = (input: Partial<SweepInput> = {}) => sweepRetention({ policy, batchSize: 10, maxRecords: 100, ...input }, ports);
  return { ledger, ports, sweep };
}

const released = (recordId: string): Seed => ({ recordId, state: 'released' });
const pending = (recordId: string): Seed => ({ recordId, state: 'pending' });

describe('sweepRetention', () => {
  it('deletes eligible content, leaves tombstones and reports only counts', async () => {
    const { ledger, sweep } = setup([released('r1'), pending('r2'), { ...released('r3'), releasedAt: '2026-09-15T00:00:00Z' }]);

    const report = await sweep();

    expect(report).toEqual({
      policyVersion: 3, outcome: 'complete', refusal: null, examined: 3, deleted: 2, deferred: 1, failed: 0,
      invalidatedApprovals: 0, reasons: { released_expired: 1, pending_expired: 1, not_yet_eligible: 1 },
      cryptoMaintenance: 'unsupported', limits: RETENTION_LIMITS,
    });
    expect(ledger.readPayload('r1')).toEqual({ kind: 'content_deleted', eventId: '$r1' });
    expect(ledger.readPayload('r3')).toEqual({ kind: 'bytes', bytes: 'bytes:r3' });
    expect(JSON.stringify(report)).not.toMatch(/\$r\d|bytes:/);
    expect(ledger.cursor).toBeNull();
  });

  it('refuses to run without an approved, valid policy and invents no default', async () => {
    const { ledger, sweep } = setup([released('r1')]);

    expect(await sweep({ policy: null })).toMatchObject({ outcome: 'refused', refusal: 'policy_absent', examined: 0 });
    expect(await sweep({ policy: { ...policy, releasedBefore: '2026-09-19T00:00:00Z' } }))
      .toMatchObject({ outcome: 'refused', refusal: 'policy_invalid' });
    expect(ledger.calls.apply).toEqual([]);
    expect(ledger.readPayload('r1').kind).toBe('bytes');
  });

  it('refuses when the local clock is behind the policy evaluation', async () => {
    const { ledger, ports } = setup([released('r1')]);
    const report = await sweepRetention(
      { policy, batchSize: 10, maxRecords: 10 }, { ...ports, clock: { now: () => '2026-09-18T10:59:59Z' } },
    );
    expect(report).toMatchObject({ outcome: 'refused', refusal: 'clock_skew', cryptoMaintenance: 'not_run' });
    expect(ledger.calls.apply).toEqual([]);
  });

  // AE1
  it('resumes an interrupted sweep without deleting a payload held by an active dispatch claim', async () => {
    const { ledger, sweep } = setup([released('r1'), released('r2'), released('r3'), released('r4')]);
    ledger.faults.apply.push('ok', 'unavailable');

    const first = await sweep();
    expect(first).toMatchObject({ outcome: 'interrupted', deleted: 1, failed: 1, reasons: { unavailable: 1 } });
    expect(first.cryptoMaintenance).toBe('not_run');
    expect(ledger.cursor).toEqual({ policyVersion: 3, after: 'r1' });

    ledger.claim('r3', 'active');
    const resumed = await sweep();

    expect(resumed).toMatchObject({ outcome: 'complete', examined: 3, deleted: 2, reasons: { active_claim: 1 } });
    expect(ledger.readPayload('r3')).toEqual({ kind: 'bytes', bytes: 'bytes:r3' });
    expect(['r1', 'r2', 'r4'].map(id => ledger.readPayload(id).kind)).toEqual(Array(3).fill('content_deleted'));
    expect(ledger.calls.apply.map(op => op.recordId)).toEqual(['r1', 'r2', 'r2', 'r4']);
  });

  it('loses the race to a dispatch claim that lands after eligibility was decided', async () => {
    const { ledger, sweep } = setup([released('r1')]);
    ledger.hooks.beforeApply = () => ledger.claim('r1', 'active');

    const report = await sweep();

    expect(report).toMatchObject({ outcome: 'complete', deleted: 0, deferred: 1, reasons: { revision_conflict: 1 } });
    expect(ledger.readPayload('r1').kind).toBe('bytes');
  });

  it('defers when the ledger reports a reference the claim port did not see', async () => {
    const { ledger, sweep } = setup([released('r1')]);
    // The claim port answers from a replica that has not caught up; the transaction sees the claim.
    ledger.claimPort.status = async () => 'none';
    ledger.claim('r1', 'active');

    expect(await sweep()).toMatchObject({ deleted: 0, reasons: { referenced: 1 } });
    expect(ledger.readPayload('r1').kind).toBe('bytes');
  });

  // AE2
  it('invalidates a stale approval when pending content is deleted instead of approving an empty replacement', async () => {
    const { ledger, sweep } = setup([pending('e7')]);
    ledger.display('approval-1', 'e7');

    const report = await sweep();

    expect(report).toMatchObject({ deleted: 1, invalidatedApprovals: 1, reasons: { pending_expired: 1 } });
    expect(ledger.approvalStatus('approval-1')).toBe('content_unavailable');
    expect(ledger.approve('approval-1', ledger.now)).toEqual({ kind: 'content_unavailable' });
    expect(ledger.readPayload('e7')).toEqual({ kind: 'content_deleted', eventId: '$e7' });
  });

  it('keeps pending content when the approval wins the race', async () => {
    const { ledger, sweep } = setup([pending('e7')]);
    ledger.display('approval-1', 'e7');
    let approved: unknown = null;
    ledger.hooks.beforeApply = () => {
      approved = ledger.approve('approval-1', ledger.now);
    };

    const report = await sweep();

    expect(approved).toEqual({ kind: 'released', bytes: 'bytes:e7' });
    expect(report).toMatchObject({ deleted: 0, invalidatedApprovals: 0, reasons: { revision_conflict: 1 } });
    expect(ledger.readPayload('e7')).toEqual({ kind: 'bytes', bytes: 'bytes:e7' });
  });

  it('keeps pending content when the owner has not allowed pending deletion', async () => {
    const { ledger, sweep } = setup([pending('e7')]);
    ledger.display('approval-1', 'e7');

    const report = await sweep({ policy: { ...policy, allowPendingDeletion: false } });

    expect(report).toMatchObject({ deleted: 0, reasons: { pending_deletion_not_allowed: 1 } });
    expect(ledger.approve('approval-1', ledger.now)).toEqual({ kind: 'released', bytes: 'bytes:e7' });
  });

  it('keeps tombstones so replay cannot recreate expired content as a new review item', async () => {
    const { ledger, sweep } = setup([pending('e7')]);
    await sweep();
    // A later sweep under the same policy keeps the tombstone: no dedup horizon is decided.
    expect(await sweep()).toMatchObject({ deleted: 0, reasons: { policy_undecided: 1 } });
    expect(ledger.ingest('$e7' as EventId)).toBe('duplicate');
  });

  it('forgets a tombstone only past an explicit dedup horizon', async () => {
    const { ledger, sweep } = setup([
      { recordId: 'old', state: 'tombstone', tombstonedAt: '2026-08-01T00:00:00Z' },
      { recordId: 'new', state: 'tombstone', tombstonedAt: '2026-09-15T00:00:00Z' },
    ]);

    const report = await sweep({ policy: { ...policy, dedupBefore: '2026-09-01T00:00:00Z' } });

    expect(report).toMatchObject({ deleted: 1, reasons: { dedup_expired: 1, not_yet_eligible: 1 } });
    expect(ledger.ingest('$old' as EventId)).toBe('new');
    expect(ledger.ingest('$new' as EventId)).toBe('duplicate');
  });

  it('keeps content and dedup identity while a dispatch outcome is unknown', async () => {
    const { ledger, sweep } = setup([released('r1'), { recordId: 't1', state: 'tombstone', tombstonedAt: '2026-08-01T00:00:00Z' }]);
    ledger.claim('r1', 'outcome_unknown');
    ledger.claim('t1', 'outcome_unknown');

    const report = await sweep({ policy: { ...policy, dedupBefore: '2026-09-01T00:00:00Z' } });

    expect(report).toMatchObject({ deleted: 0, reasons: { unresolved_outcome: 2 } });
    expect(ledger.ingest('$t1' as EventId)).toBe('duplicate');
  });

  it('never reports a lost deletion response as success, and does not delete twice on resume', async () => {
    const { ledger, sweep } = setup([released('r1'), released('r2')]);
    ledger.faults.apply.push('lost_applied');

    const first = await sweep();
    expect(first).toMatchObject({ outcome: 'interrupted', deleted: 0, failed: 1, reasons: { outcome_unknown: 1 } });
    expect(ledger.cursor).toBeNull();

    const resumed = await sweep();
    // r1 is now a tombstone, kept because no dedup horizon is decided.
    expect(resumed).toMatchObject({ outcome: 'complete', deleted: 1, reasons: { policy_undecided: 1, released_expired: 1 } });
    expect(ledger.calls.apply.map(op => op.recordId)).toEqual(['r1', 'r2']);
  });

  it('recognises a retried operation that already landed', async () => {
    const { ledger, ports } = setup([released('r1')]);
    const stale = await ports.records.page({ after: null, limit: 1 });
    ledger.faults.apply.push('lost_applied');
    await sweepRetention({ policy, batchSize: 10, maxRecords: 10 }, ports);
    // A page read before the lost write replays the same record and revision.
    ports.records.page = async () => stale;

    expect(await sweepRetention({ policy, batchSize: 10, maxRecords: 10 }, ports))
      .toMatchObject({ outcome: 'complete', deleted: 1, reasons: { already_deleted: 1 } });
  });

  it('returns a partial report when storage fails or throws', async () => {
    for (const fault of ['unavailable', 'throw'] as const) {
      const { ledger, sweep } = setup([released('r1'), released('r2')]);
      ledger.faults.page.push('ok', fault);
      const report = await sweep({ batchSize: 1 });
      expect(report).toMatchObject({ outcome: 'interrupted', examined: 1, deleted: 1 });
      expect(report.cryptoMaintenance).toBe('not_run');
      expect(ledger.cursor).toEqual({ policyVersion: 3, after: 'r1' });
    }
  });

  it('refuses when the cursor cannot be read, and interrupts when it cannot be written', async () => {
    const unread = setup([released('r1')]);
    unread.ledger.faults.readCursor.push('unavailable');
    expect(await unread.sweep()).toMatchObject({ outcome: 'refused', refusal: 'cursor_unavailable' });

    const unwritten = setup([released('r1')]);
    unwritten.ledger.faults.writeCursor.push('unavailable');
    expect(await unwritten.sweep()).toMatchObject({ outcome: 'interrupted', deleted: 1 });
  });

  it('stops when the ledger holds a newer policy', async () => {
    const { ledger, sweep } = setup([released('r1')], 4);
    expect(await sweep()).toMatchObject({ outcome: 'interrupted', failed: 1, reasons: { stale_policy: 1 } });
    expect(ledger.readPayload('r1').kind).toBe('bytes');
  });

  it('bounds each call and resumes where the previous one stopped', async () => {
    const { ledger, sweep } = setup(['a', 'b', 'c', 'd', 'e'].map(released));

    const first = await sweep({ batchSize: 2, maxRecords: 3 });
    expect(first).toMatchObject({ outcome: 'budget_exhausted', examined: 3, cryptoMaintenance: 'not_run' });
    expect(ledger.cursor).toEqual({ policyVersion: 3, after: 'c' });

    const second = await sweep({ batchSize: 2, maxRecords: 3 });
    expect(second).toMatchObject({ outcome: 'complete', examined: 2, cryptoMaintenance: 'unsupported' });
    expect(ledger.calls.crypto).toBe(1);
    expect(ledger.cursor).toBeNull();
  });

  it('restarts from the beginning under a new policy version', async () => {
    const { ledger, sweep } = setup(['a', 'b', 'c'].map(pending), 5);
    await ledger.records.writeCursor({ policyVersion: 3, after: 'b' });

    const report = await sweep({ policy: { ...policy, version: 5 } });

    expect(report).toMatchObject({ outcome: 'complete', examined: 3, deleted: 3 });
  });

  it('stops on a ledger page that would loop or skip', async () => {
    const { ports } = setup([released('r1')]);
    const page = await ports.records.page({ after: null, limit: 10 });
    // Ignores `after` and never finishes: the same record comes back forever.
    ports.records.page = async () => (page.kind === 'page' ? { ...page, exhausted: false } : page);

    const report = await sweepRetention({ policy, batchSize: 10, maxRecords: 10 }, ports);

    expect(report).toMatchObject({ outcome: 'interrupted', examined: 2, reasons: { invalid_ledger_answer: 1 } });
  });

  it('reports crypto maintenance failure without claiming it ran', async () => {
    const { ports } = setup([]);
    const report = await sweepRetention({ policy, batchSize: 10, maxRecords: 10 }, {
      ...ports, crypto: { maintain: async () => { throw new Error('sdk'); } },
    });
    expect(report).toMatchObject({ outcome: 'complete', examined: 0, cryptoMaintenance: 'failed' });
  });

  it('rejects unbounded batches', async () => {
    const { sweep } = setup([]);
    await expect(sweep({ batchSize: 0 })).rejects.toThrow(RangeError);
    await expect(sweep({ maxRecords: Number.POSITIVE_INFINITY })).rejects.toThrow(RangeError);
  });
});
