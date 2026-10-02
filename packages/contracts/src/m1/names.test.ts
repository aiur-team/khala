import { expect, it } from 'vitest';
import { checkName, decodeOwnerAgents, ownerAgentsKey, defaultAgentName, isDefaultAgentName, nameKey, suggestUsername } from './names';

it('accepts mention-safe usernames and trims the display form', () => {
  for (const name of ['Kevin', 'kw', 'kevin.weaver', 'K-9', 'a'.repeat(24)]) {
    expect(checkName(name, 'username')).toEqual({ ok: true, name });
  }
  expect(checkName(' Kevin ', 'username')).toEqual({ ok: true, name: 'Kevin' });
  expect(nameKey('KEVIN')).toBe('names/v1/kevin');
});
it('rejects invalid names with finite reasons', () => {
  for (const [name, error] of [
    ['k', 'too_short'], ['a'.repeat(25), 'too_long'], ['-kevin', 'invalid_characters'],
    ['kevin-', 'invalid_characters'], ['ke..vin', 'invalid_characters'], ['ke_-vin', 'invalid_characters'],
    ['kévin', 'invalid_characters'], ['kevin weaver', 'invalid_characters'], ['admin', 'reserved'],
    ['ADMIN', 'reserved'], ['Kevin-Claude', 'reserved'], ['kevin-codex-2', 'reserved'],
  ]) expect(checkName(name, 'username')).toEqual({ ok: false, error });
  expect(checkName(null, 'username')).toEqual({ ok: false, error: 'invalid_characters' });
  expect(checkName('', 'username')).toEqual({ ok: false, error: 'too_short' });
});
it('shares agent rules while allowing model suffixes', () => {
  expect(checkName('Kevin-Claude', 'agent')).toEqual({ ok: true, name: 'Kevin-Claude' });
  expect(checkName('a'.repeat(40), 'agent').ok).toBe(true);
  expect(checkName('a'.repeat(41), 'agent')).toEqual({ ok: false, error: 'too_long' });
  expect(defaultAgentName('Kevin', 'codex', 3)).toBe('Kevin-Codex-3');
  expect(defaultAgentName('Kevin', 'claude')).toBe('Kevin-Claude');
  expect(isDefaultAgentName('kevin-claude-2', 'Kevin', 'claude')).toBe(true);
  expect(isDefaultAgentName('KevinXWeaver-Claude', 'Kevin.Weaver', 'claude')).toBe(false);
  expect(isDefaultAgentName('Kevin-Claude-more', 'Kevin', 'claude')).toBe(false);
});
it('suggests valid base usernames from verified email', () => {
  expect(suggestUsername('kevin.weaver2@gmail.com')).toBe('Kevin');
  expect(suggestUsername('é@x')).toBe('User');
  expect(suggestUsername('admin@x')).toBe('User');
  expect(checkName(suggestUsername('a'.repeat(30) + '@x'), 'username').ok).toBe(true);
});

it('decodes a bounded owner agent index and escapes its key', () => {
  expect(ownerAgentsKey('owner/a b')).toBe('owner-agents/owner%2Fa%20b');
  const record = { v: 1, ownerId: 'owner', agents: ['@agent:matrix.test'] };
  expect(decodeOwnerAgents(record)).toEqual({ ok: true, value: record });
  expect(decodeOwnerAgents({ ...record, agents: [] }).ok).toBe(true);
  expect(decodeOwnerAgents({ ...record, agents: Array.from({ length: 200 }, (_, n) => `@agent${n}:matrix.test`) }).ok).toBe(true);
  for (const invalid of [null, { ...record, v: 2 }, { ...record, ownerId: '' }, { ...record, extra: true },
    { ...record, agents: ['not-matrix'] }, { ...record, agents: 'wrong' }, { ...record, agents: Array(201).fill('@agent:matrix.test') }]) {
    expect(decodeOwnerAgents(invalid).ok).toBe(false);
  }
  expect(decodeOwnerAgents({ ...record, agents: ['@agent:matrix.test', '@agent:matrix.test'] }))
    .toEqual({ ok: false, error: { path: 'agents[1]', code: 'duplicate' } });
});
