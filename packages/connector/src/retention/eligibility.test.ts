// U1: the pure eligibility predicate against explicit policies and a fixed clock.

import type { EventId } from '@khala/contracts/delivery/ids';
import { describe, expect, it } from 'vitest';
import { type RetentionPolicy, type RetentionRecord, decodeRetentionPolicy, evaluateRecord } from './eligibility';

const now = '2026-09-18T12:00:00Z';

const policy = (change: Partial<RetentionPolicy> = {}): RetentionPolicy => ({
  version: 3,
  evaluatedAt: '2026-09-18T11:00:00Z',
  pendingBefore: '2026-09-10T00:00:00Z',
  releasedBefore: '2026-09-10T00:00:00Z',
  allowPendingDeletion: true,
  dedupBefore: '2026-09-01T00:00:00Z',
  ...change,
});

const record = (change: Partial<RetentionRecord> = {}): RetentionRecord => ({
  recordId: 'r1',
  revision: 'rev1',
  eventId: '$event1' as EventId,
  state: 'pending',
  receivedAt: '2026-09-01T00:00:00Z',
  releasedAt: null,
  tombstonedAt: null,
  backupHold: false,
  ...change,
});

const released = (releasedAt: string) => record({ state: 'released', releasedAt });
const tombstone = (tombstonedAt: string) => record({ state: 'tombstone', tombstonedAt });

describe('decodeRetentionPolicy', () => {
  it('accepts an explicit policy with undecided classes left null', () => {
    const decoded = decodeRetentionPolicy(policy({ pendingBefore: null, releasedBefore: null, dedupBefore: null }));
    expect(decoded).toEqual({ ok: true, value: policy({ pendingBefore: null, releasedBefore: null, dedupBefore: null }) });
  });

  it.each([
    ['a cutoff after evaluation', { releasedBefore: '2026-09-18T11:00:01Z' }, 'releasedBefore'],
    ['a local-time cutoff', { pendingBefore: '2026-09-10T00:00:00+02:00' }, 'pendingBefore'],
    ['version zero', { version: 0 }, 'version'],
    ['a missing decision', { allowPendingDeletion: undefined }, 'allowPendingDeletion'],
  ])('rejects %s', (_name, change, field) => {
    const decoded = decodeRetentionPolicy({ ...policy(), ...change });
    expect(decoded).toMatchObject({ ok: false, field });
  });

  it('rejects unknown fields instead of guessing what they meant', () => {
    expect(decodeRetentionPolicy({ ...policy(), ttlDays: 30 })).toMatchObject({ ok: false, field: 'ttlDays' });
  });
});

describe('evaluateRecord', () => {
  it('deletes content strictly before each cutoff and keeps content at the boundary', () => {
    expect(evaluateRecord(policy(), record({ receivedAt: '2026-09-09T23:59:59Z' }), 'none', now))
      .toEqual({ kind: 'delete', action: 'delete_payload', reason: 'pending_expired' });
    expect(evaluateRecord(policy(), record({ receivedAt: '2026-09-10T00:00:00Z' }), 'none', now))
      .toEqual({ kind: 'defer', reason: 'not_yet_eligible' });
    expect(evaluateRecord(policy(), released('2026-09-09T23:59:59.999Z'), 'none', now))
      .toEqual({ kind: 'delete', action: 'delete_payload', reason: 'released_expired' });
    expect(evaluateRecord(policy(), released('2026-09-10T00:00:00Z'), 'none', now))
      .toEqual({ kind: 'defer', reason: 'not_yet_eligible' });
    expect(evaluateRecord(policy(), tombstone('2026-08-31T23:59:59Z'), 'none', now))
      .toEqual({ kind: 'delete', action: 'delete_tombstone', reason: 'dedup_expired' });
    expect(evaluateRecord(policy(), tombstone('2026-09-01T00:00:00Z'), 'none', now))
      .toEqual({ kind: 'defer', reason: 'not_yet_eligible' });
  });

  it('keeps every class whose horizon the owner has not decided', () => {
    const undecided = policy({ pendingBefore: null, releasedBefore: null, dedupBefore: null });
    expect(evaluateRecord(undecided, record(), 'none', now)).toEqual({ kind: 'defer', reason: 'policy_undecided' });
    expect(evaluateRecord(undecided, released('2020-01-01T00:00:00Z'), 'none', now))
      .toEqual({ kind: 'defer', reason: 'policy_undecided' });
    expect(evaluateRecord(undecided, tombstone('2020-01-01T00:00:00Z'), 'none', now))
      .toEqual({ kind: 'defer', reason: 'policy_undecided' });
  });

  it('keeps pending content unless pending deletion is explicitly allowed', () => {
    expect(evaluateRecord(policy({ allowPendingDeletion: false }), record(), 'none', now))
      .toEqual({ kind: 'defer', reason: 'pending_deletion_not_allowed' });
    // Released content follows its own horizon.
    expect(evaluateRecord(policy({ allowPendingDeletion: false }), released('2026-09-02T00:00:00Z'), 'none', now).kind)
      .toBe('delete');
  });

  it('lets references win over age', () => {
    const old = released('2026-09-02T00:00:00Z');
    expect(evaluateRecord(policy(), old, 'active', now)).toEqual({ kind: 'defer', reason: 'active_claim' });
    expect(evaluateRecord(policy(), old, 'unavailable', now)).toEqual({ kind: 'defer', reason: 'dispatch_unknown' });
    expect(evaluateRecord(policy(), old, 'outcome_unknown', now)).toEqual({ kind: 'defer', reason: 'unresolved_outcome' });
    expect(evaluateRecord(policy(), { ...old, backupHold: true }, 'none', now))
      .toEqual({ kind: 'defer', reason: 'backup_dependency' });
  });

  it('keeps the dedup identity of an unresolved dispatch even past its horizon', () => {
    expect(evaluateRecord(policy(), tombstone('2020-01-01T00:00:00Z'), 'outcome_unknown', now))
      .toEqual({ kind: 'defer', reason: 'unresolved_outcome' });
  });

  it('treats timestamps from the future as clock skew, not age', () => {
    expect(evaluateRecord(policy(), released('2026-09-18T12:00:01Z'), 'none', now))
      .toEqual({ kind: 'defer', reason: 'clock_skew' });
  });

  it('keeps records whose facts are inconsistent', () => {
    expect(evaluateRecord(policy(), record({ state: 'released', releasedAt: null }), 'none', now))
      .toEqual({ kind: 'defer', reason: 'invalid_record' });
    expect(evaluateRecord(policy(), record({ state: 'tombstone', tombstonedAt: null }), 'none', now))
      .toEqual({ kind: 'defer', reason: 'invalid_record' });
    expect(evaluateRecord(policy(), record({ receivedAt: 'Sep 1 2026' }), 'none', now))
      .toEqual({ kind: 'defer', reason: 'invalid_record' });
  });
});
