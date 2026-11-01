import { LOCAL_OWNER_ID, decodeLocalChannelSummary } from '@khala/contracts/m1/local';
import { ok, rejected, unavailable, type ChannelAdministrationPort, type OwnerId } from '@khala/contracts/messaging/index';
import { decodeEmpty, localChannelPath, type LocalHttp } from './http';

/** Local channels have one human, their creator, who owns every agent. */
export function createLocalAdministration(http: LocalHttp): ChannelAdministrationPort {
  return {
    async creator(roomId, options) {
      const result = await http.get(localChannelPath(roomId, '?wire=2&mute=1'), decodeLocalChannelSummary, options?.signal);
      if (result.kind === 'ok') return ok(LOCAL_OWNER_ID as OwnerId);
      return result.kind === 'error' && result.status === 404 ? rejected('not_found') : unavailable();
    },
    async removeAgent({ roomId, userId }, options) {
      const result = await http.send('DELETE', localChannelPath(roomId, `/members/${encodeURIComponent(userId)}`), undefined, decodeEmpty, options?.signal);
      if (result.kind === 'ok') return ok(null);
      return result.kind === 'error' && result.status === 404 ? rejected('not_found') : unavailable();
    },
    async removeHuman({ ownerId }) {
      return rejected(ownerId === LOCAL_OWNER_ID ? 'forbidden' : 'not_found');
    },
  };
}
