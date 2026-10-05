import { decodeChannelNameResult, localChannelNamePath } from '@khala/contracts/m1/channel-names';
import type { NameError } from '@khala/contracts/m1/names';
import type { ChannelNamesPort } from '../../features/channel/ports';
import type { LocalHttp } from './http';

/** The local owner's own name in one channel, through the helper's owner-only route. */
export function createLocalChannelNamesPort(http: LocalHttp, options?: { onSaved?: (roomId: string) => void }): ChannelNamesPort {
  return { async setOwnName(roomId, name, signal) {
    const result = await http.send('POST', localChannelNamePath(roomId), { name }, decodeChannelNameResult, signal);
    if (result.kind === 'ok') { options?.onSaved?.(roomId); return { kind: 'ok', name: result.value.name }; }
    if (result.kind === 'error') {
      if (result.status === 401) return { kind: 'error', code: 'signed_out' };
      if (result.status === 409 && result.code === 'name_taken') return { kind: 'error', code: 'name_taken' };
      if (result.status === 400 && result.code === 'invalid_name') {
        const reasons: readonly NameError[] = ['too_short', 'too_long', 'invalid_characters', 'reserved'];
        const reason = reasons.find(value => value === result.reason);
        return { kind: 'error', code: 'invalid_name', ...(reason ? { reason } : {}) };
      }
    }
    return { kind: 'error', code: 'unavailable' };
  } };
}
