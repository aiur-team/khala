import { expect, it } from 'vitest';
import { decodeNameReservation, decodeProfileRecord, decodeProfileView, profileRecordKey } from './profile';
const record = { v: 1, ownerId: 'own_abc', username: 'Kevin', updatedAt: '2026-10-02T18:00:00.000Z' };
it('decodes exact profile and reservation contracts', () => {
  expect(decodeProfileRecord(record)).toEqual({ ok: true, value: record });
  expect(profileRecordKey('own_abc')).toBe('profiles/own_abc');
  expect(profileRecordKey('owner/a')).toBe('profiles/owner%2Fa');
  for (const view of [{ username: null, suggestion: 'Kevin' }, { username: 'KEVIN', suggestion: 'Kevin' }]) {
    expect(decodeProfileView(view)).toEqual({ ok: true, value: view });
  }
  for (const value of [{ v: 1, kind: 'human', ownerId: 'own_abc' },
    { v: 1, kind: 'agent', ownerId: 'own_abc', matrixUserId: '@agent:matrix.test' }]) {
    expect(decodeNameReservation(value)).toEqual({ ok: true, value });
    expect(decodeNameReservation({ ...value, extra: true }).ok).toBe(false);
  }
  expect(decodeProfileRecord({ ...record, extra: true }).ok).toBe(false);
  expect(decodeProfileView({ username: null, suggestion: 'Kevin', extra: true }).ok).toBe(false);
});
it('rejects malformed names, versions and timestamps', () => {
  for (const patch of [{ username: 'admin' }, { username: ' Kevin ' }, { updatedAt: 'yesterday' }, { v: 2 }, { ownerId: '' }]) {
    expect(decodeProfileRecord({ ...record, ...patch }).ok).toBe(false);
  }
  expect(decodeProfileView({ username: null, suggestion: 'a' }).ok).toBe(false);
  expect(decodeNameReservation({ v: 1, kind: 'agent', ownerId: 'own_abc' }).ok).toBe(false);
});
