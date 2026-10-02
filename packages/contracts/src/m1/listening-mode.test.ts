import { expect, it } from 'vitest';
import { decodeListeningModeCommand, memberListeningMode, LISTENING_MODE_MEMBER_KEY } from './listening-mode';
const command = { v: 1, agent: '@agent:khala.local', mode: 'async' };
it('decodes an exact mode command', () => expect(decodeListeningModeCommand(command)).toEqual({ ok: true, value: command }));
it.each([{ ...command, extra: true }, { ...command, mode: 'loud' }, { ...command, agent: 'agent' }, { ...command, v: 2 }])('rejects invalid command %j', input => expect(decodeListeningModeCommand(input).ok).toBe(false));
it.each([{}, null, { [LISTENING_MODE_MEMBER_KEY]: 'loud' }])('defaults invalid member content %j to sync', input => expect(memberListeningMode(input)).toBe('sync'));
it('reads a valid member mode', () => expect(memberListeningMode({ [LISTENING_MODE_MEMBER_KEY]: 'async' })).toBe('async'));
