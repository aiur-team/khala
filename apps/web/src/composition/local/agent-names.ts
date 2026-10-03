import { decodeAgentRenameResult } from '@khala/contracts/m1/agent-names';
import type { NameError } from '@khala/contracts/m1/names';
import type { AgentNamesPort } from '../../features/channel/ports';
import type { LocalHttp } from './http';

export function createLocalAgentNamesPort(http: LocalHttp): AgentNamesPort {
  return { async rename(matrixUserId, name, signal) {
    const result = await http.send('POST', `/api/local/agents/${encodeURIComponent(matrixUserId)}/name`, { name }, decodeAgentRenameResult, signal);
    if (result.kind === 'ok') return result.value.matrixUserId === matrixUserId ? { kind: 'ok', name: result.value.name } : { kind: 'error', code: 'unavailable' };
    if (result.kind === 'error') {
      if (result.status === 401) return { kind: 'error', code: 'signed_out' };
      if (result.status === 400 && result.code === 'invalid_name') {
        const reasons: readonly NameError[] = ['too_short', 'too_long', 'invalid_characters', 'reserved'];
        const reason = reasons.find(value => value === result.reason);
        return { kind: 'error', code: 'invalid_name', ...(reason ? { reason } : {}) };
      }
      if (result.status === 403 && result.code === 'not_owner') return { kind: 'error', code: 'not_owner' };
      if (result.status === 404 && result.code === 'not_found') return { kind: 'error', code: 'not_found' };
      if (result.status === 409 && result.code === 'name_taken') return { kind: 'error', code: 'name_taken' };
    }
    return { kind: 'error', code: 'unavailable' };
  } };
}
