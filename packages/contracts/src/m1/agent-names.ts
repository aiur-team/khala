import { type Decoded, decodeWith, fail, identifier, object } from '../messaging/decode';
import { readMatrixUserId } from './agent-join';
import { checkName } from './names';

export const AGENT_RENAME_PATH = '/api/human/agents/rename';
export type AgentRenameResult = { matrixUserId: string; name: string };

export function decodeAgentRenameResult(input: unknown): Decoded<AgentRenameResult> {
  return decodeWith(() => {
    const r = object(input, '', ['matrixUserId', 'name']);
    const name = identifier(r.field('name'), r.at('name'));
    const checked = checkName(name, 'agent');
    if (!checked.ok || checked.name !== name) fail(r.at('name'), 'invalid_value');
    return { matrixUserId: readMatrixUserId(r.field('matrixUserId'), r.at('matrixUserId')), name };
  });
}
