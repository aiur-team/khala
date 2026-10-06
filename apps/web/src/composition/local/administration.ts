import { LOCAL_OWNER_ID, decodeLocalChannelSummary } from '@khala/contracts/m1/local';
import { ok, rejected, unavailable, type ChannelAdministrationPort, type OwnerId } from '@khala/contracts/messaging/index';
import { localChannelPath, type LocalHttp } from './http';

/** Local channels have one human, their creator. Agents keep the existing removal API. */
export function createLocalAdministration(http: LocalHttp): ChannelAdministrationPort {
  return {
    async creator(roomId, options) {
      const result = await http.get(localChannelPath(roomId), decodeLocalChannelSummary, options?.signal);
      if (result.kind === 'ok') return ok(LOCAL_OWNER_ID as OwnerId);
      return result.kind === 'error' && result.status === 404 ? rejected('not_found') : unavailable();
    },
    async removeHuman({ ownerId }) {
      return rejected(ownerId === LOCAL_OWNER_ID ? 'forbidden' : 'not_found');
    },
  };
}
