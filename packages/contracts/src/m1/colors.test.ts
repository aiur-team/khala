import { expect, it } from 'vitest';
import { HUMAN_COLOR_IDS, decodeHumanColorRecord, defaultHumanColor, fnv1a, humanColorRecordKey, isHumanColorId } from './colors';

it('defines ten stable colour ids in palette order', () => {
  expect(HUMAN_COLOR_IDS).toEqual(['red', 'orange', 'amber', 'lime', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink']);
  for (const id of HUMAN_COLOR_IDS) expect(isHumanColorId(id)).toBe(true);
  for (const invalid of ['#ff0000', 'Blue', '', null, 1]) expect(isHumanColorId(invalid)).toBe(false);
});
it('preserves the identity hash and assigns deterministic defaults across the palette', () => {
  expect(fnv1a('owner-kevin')).toBe(2051763560);
  const seen = new Set<string>();
  for (let index = 0; index < 1000; index++) {
    const ownerId = `owner-${index}`;
    const color = defaultHumanColor(ownerId);
    expect(defaultHumanColor(ownerId)).toBe(color);
    expect(isHumanColorId(color)).toBe(true);
    seen.add(color);
  }
  expect(seen.size).toBe(10);
});
it('decodes exact colour records and encodes owner keys', () => {
  const record = { v: 1, ownerId: 'owner/a', color: 'pink' };
  expect(decodeHumanColorRecord(record)).toEqual({ ok: true, value: record });
  expect(humanColorRecordKey(record.ownerId)).toBe('humans/owner%2Fa/color');
  for (const patch of [{ extra: true }, { color: 'chartreuse' }, { v: 2 }, { ownerId: '' }]) {
    expect(decodeHumanColorRecord({ ...record, ...patch }).ok).toBe(false);
  }
});
