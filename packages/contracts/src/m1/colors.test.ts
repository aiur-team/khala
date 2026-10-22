import { expect, it } from 'vitest';
import { CHANNEL_COLORS_MEMBER_KEY, AGENT_VARIANT_COUNT, HUMAN_COLOR_IDS, decodeHumanColorRecord, defaultHumanColor, fnv1a, humanColorRecordKey, isAgentVariant, isHumanColorId, memberChannelColors } from './colors';

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
  expect(memberChannelColors({ membership: 'join', [CHANNEL_COLORS_MEMBER_KEY]: { color: 'teal', agents: { '@a:x': 2 } } }))
    .toEqual({ color: 'teal', agents: { '@a:x': 2 } });
  expect(memberChannelColors({ [CHANNEL_COLORS_MEMBER_KEY]: { color: '#fff', agents: { '@a:x': 0, '@b:x': 9, '@c:x': 1.5, d: 3, '@e:x': 8 } } }))
    .toEqual({ agents: { '@e:x': 8 } });
  expect(memberChannelColors({ [CHANNEL_COLORS_MEMBER_KEY]: { agents: [1] } })).toEqual({ agents: {} });
  expect(memberChannelColors({ membership: 'join' })).toBeNull();
  expect(memberChannelColors(null)).toBeNull();
  expect(isAgentVariant(AGENT_VARIANT_COUNT - 1)).toBe(true);
});
