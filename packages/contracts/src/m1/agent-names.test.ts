import { expect, it } from 'vitest';
import { AGENT_RENAME_PATH, decodeAgentRenameResult } from './agent-names';

it('decodes an exact agent rename result with a canonical valid name', () => {
  const result = { matrixUserId: '@agent:matrix.test', name: 'Reviewer' };
  expect(AGENT_RENAME_PATH).toBe('/api/human/agents/rename');
  expect(decodeAgentRenameResult(result)).toEqual({ ok: true, value: result });
  expect(decodeAgentRenameResult({ ...result, extra: true }).ok).toBe(false);
  expect(decodeAgentRenameResult({ name: result.name }).ok).toBe(false);
});

it.each(['a', 'a'.repeat(41), 'ab cd', ' Reviewer ', 'admin', '', null])('rejects invalid result name %j', name => {
  expect(decodeAgentRenameResult({ matrixUserId: '@agent:matrix.test', name }).ok).toBe(false);
});

it.each(['agent', '', null])('rejects malformed Matrix user id %j', matrixUserId => {
  expect(decodeAgentRenameResult({ matrixUserId, name: 'Reviewer' }).ok).toBe(false);
});
