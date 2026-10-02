import { AGENT_RENAME_PATH } from '@khala/contracts/m1/agent-names';
import { readMatrixUserId } from '@khala/contracts/m1/agent-join';
import { checkName } from '@khala/contracts/m1/names';
import { decodeWith, object } from '@khala/contracts/messaging/decode';
import type { AuthService } from '../auth/index';
import { renameAgent, type AgentRenameDeps } from './rename';
export { AGENT_RENAME_PATH };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: {
  'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
} });
const error = (status: number, code: string) => json(status, { error: code });
export function createAgentRenameHandler(deps: AgentRenameDeps & { auth: Pick<AuthService, 'requireHumanMutation'> }) {
  return async (request: Request): Promise<Response> => {
    try {
      if (request.method !== 'POST') return error(405, 'method_not_allowed');
      const auth = await deps.auth.requireHumanMutation(request);
      if (auth.kind === 'unavailable') return error(503, 'unavailable');
      if (auth.kind === 'rejected') return error(auth.code === 'signed_out' ? 401 : auth.code === 'not_a_mutation' ? 405 : 403,
        auth.code === 'not_a_mutation' ? 'method_not_allowed' : auth.code);
      let input: unknown;
      try { input = await request.json(); } catch { return error(400, 'invalid_request'); }
      const parsed = decodeWith(() => {
        const r = object(input, '', ['matrixUserId', 'name']);
        return { matrixUserId: readMatrixUserId(r.field('matrixUserId'), r.at('matrixUserId')), name: r.field('name') };
      });
      if (!parsed.ok || typeof parsed.value.name !== 'string') return error(400, 'invalid_request');
      const checked = checkName(parsed.value.name, 'agent');
      if (!checked.ok) return json(400, { error: 'invalid_name', reason: checked.error });
      const result = await renameAgent(deps, auth.context.principal.ownerId, parsed.value.matrixUserId, checked.name);
      if (result === 'ok') return json(200, { matrixUserId: parsed.value.matrixUserId, name: checked.name });
      const status = { invalid: 400, not_found: 404, not_owner: 403, taken: 409, unavailable: 503 }[result];
      return error(status, result === 'taken' ? 'name_taken' : result === 'invalid' ? 'invalid_name' : result);
    } catch { return error(503, 'unavailable'); }
  };
}
