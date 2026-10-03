import { decodeLocalShareLink } from '@khala/contracts/m1/local';
import type { AdmissionPort } from '@khala/contracts/messaging/admission';
import { decodePersonalChannelLinkResult } from '@khala/contracts/messaging/channel-link';
import { unavailable } from '@khala/contracts/messaging/outcomes';
import type { HumanChannelLinks } from '../human/channel-links';
import { localChannelPath, type LocalHttp } from './http';

export function createLocalChannelLinks(http: LocalHttp): HumanChannelLinks {
  return {
    resolve: async () => ({ v: 1, kind: 'unavailable' }),
    async personal(roomId, signal) {
      try {
        const result = await http.send('POST', localChannelPath(roomId, '/links'), {}, decodeLocalShareLink, signal);
        if (result.kind === 'ok') {
          const decoded = decodePersonalChannelLinkResult({ v: 1, kind: 'personal_link',
            shareUrl: result.value.shareLink, expiresAt: result.value.expiresAt });
          if (decoded.ok) return decoded.value;
        } else if (result.kind === 'error') {
          if (result.status === 401) return { v: 1, kind: 'auth_required' };
          if (result.status === 403) return { v: 1, kind: 'forbidden' };
        }
      } catch { /* A transport failure is an unavailable link. */ }
      return { v: 1, kind: 'unavailable' };
    },
  };
}

export const localAdmission: AdmissionPort = {
  share: async () => unavailable(), inspect: async () => 'unavailable', admit: async () => unavailable(),
};
