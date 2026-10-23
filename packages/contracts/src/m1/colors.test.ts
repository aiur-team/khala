import { expect, it } from 'vitest';
import { CHANNEL_COLORS_MEMBER_KEY, HUMAN_COLOR_IDS, decodeHumanColorRecord, defaultHumanColor, fnv1a, humanColorRecordKey, isChannelColorKey, isHumanColorId, memberChannelColors } from './colors';

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
it('reads a member event\'s channel colours, dropping invalid parts', () => {
  expect(memberChannelColors({ membership: 'join', [CHANNEL_COLORS_MEMBER_KEY]: { color: 'teal.2', agents: { '@a:x': 'red' } } }))
    .toEqual({ color: 'teal.2', agents: { '@a:x': 'red' } });
  expect(memberChannelColors({ [CHANNEL_COLORS_MEMBER_KEY]: { color: '#fff', agents: { '@a:x': 2, '@b:x': 'red.9', '@c:x': 'red.0', d: 'red', '@e:x': 'pink.8' } } }))
    .toEqual({ agents: { '@e:x': 'pink.8' } });
  expect(memberChannelColors({ [CHANNEL_COLORS_MEMBER_KEY]: { agents: [1] } })).toEqual({ agents: {} });
  expect(memberChannelColors({ membership: 'join' })).toBeNull();
  expect(memberChannelColors(null)).toBeNull();
});
it('accepts base colours and their shades 1..8 as channel colour keys', () => {
  for (const key of ['red', 'red.1', 'pink.8']) expect(isChannelColorKey(key)).toBe(true);
  for (const key of ['red.0', 'red.9', 'red.01', 'red.1.1', 'chartreuse', 'red.', 3, null]) expect(isChannelColorKey(key)).toBe(false);
});
