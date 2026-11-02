import { expect, it } from 'vitest';
import { decodeListeningModeCommand, memberListeningMode, LISTENING_MODE_MEMBER_KEY } from './listening-mode';
const command = { v: 1, agent: '@agent:khala.local', mode: 'async' };
it('decodes an exact mode command', () => expect(decodeListeningModeCommand(command)).toEqual({ ok: true, value: command }));
it.each([{ ...command, extra: true }, { ...command, mode: 'loud' }, { ...command, agent: 'agent' }, { ...command, v: 2 }])('rejects invalid command %j', input => expect(decodeListeningModeCommand(input).ok).toBe(false));
it('decodes an optional boolean lock', () => {
  for (const locked of [true, false]) expect(decodeListeningModeCommand({ ...command, locked })).toEqual({ ok: true, value: { ...command, locked } });
  expect(decodeListeningModeCommand({ ...command, locked: 'yes' }).ok).toBe(false);
});
it('decodes an optional listener timeout from the fixed choices only', () => {
  for (const idleMuteMin of [0, 15, 60, 240, 1440]) expect(decodeListeningModeCommand({ ...command, locked: true, idleMuteMin })).toEqual({ ok: true, value: { ...command, locked: true, idleMuteMin } });
  for (const idleMuteMin of [1, -60, '60', null]) expect(decodeListeningModeCommand({ ...command, idleMuteMin }).ok).toBe(false);
});
it.each([{}, null])('defaults missing member mode %j to sync', input => expect(memberListeningMode(input)).toBe('sync'));
it('reads a mode from a newer client as async', () => expect(memberListeningMode({ [LISTENING_MODE_MEMBER_KEY]: 'loud' })).toBe('async'));
it('decodes mute', () => {
  expect(decodeListeningModeCommand({ ...command, mode: 'mute' }).ok).toBe(true);
  expect(memberListeningMode({ [LISTENING_MODE_MEMBER_KEY]: 'mute' })).toBe('mute');
});
it('reads a valid member mode', () => expect(memberListeningMode({ [LISTENING_MODE_MEMBER_KEY]: 'async' })).toBe('async'));
