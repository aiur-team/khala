import { expect, it } from 'vitest';
import { decodeHumanInitialsRecord, humanInitialsRecordKey, isCanonicalInitials, normalizeInitials, readHumanInitials } from './initials';

it.each([['KW', 'KW'], ['kw', 'KW'], ['k1', 'K1'], ['42', '42'], ['é1', 'É1'], ['e\u03011', 'É1'], ['李明', '李明']])('normalizes %s to %s', (input, expected) => {
  expect(normalizeInitials(input)).toBe(expected);
  expect(isCanonicalInitials(expected)).toBe(true);
  expect(readHumanInitials(expected, 'initials')).toBe(expected);
});
it.each(['K', 'KWS', 'K ', ' K', 'K.', '😀K', '👍🏽', 'ß', 'ßa', '', null, 1, 'K\u0301', 'ⅣK'])('rejects invalid initials %s', input => {
  expect(normalizeInitials(input)).toBeNull();
  expect(isCanonicalInitials(input)).toBe(false);
});
it('requires canonical initials and exact nullable records', () => {
  expect(isCanonicalInitials('kw')).toBe(false);
  expect(isCanonicalInitials('e\u03011')).toBe(false);
  expect(() => readHumanInitials('kw', 'initials')).toThrow();
  expect(humanInitialsRecordKey('owner/a')).toBe('humans/owner%2Fa/initials');
  for (const initials of ['KW', null]) {
    const record = { v: 1, ownerId: 'owner/a', initials };
    expect(decodeHumanInitialsRecord(record)).toEqual({ ok: true, value: record });
    for (const patch of [{ initials: 'kw' }, { extra: true }, { v: 2 }, { ownerId: '' }]) {
      expect(decodeHumanInitialsRecord({ ...record, ...patch }).ok).toBe(false);
    }
  }
  expect(decodeHumanInitialsRecord({ v: 1, ownerId: 'owner/a' }).ok).toBe(false);
});
