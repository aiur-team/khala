// The live binding Stop port over the local server's human-only Stop endpoint.

import { REQUEST_SECRET_HEADER } from '@khala/messaging/local/http/index';
import { type BindingStopPort, decodeStopReply } from '../controls/stop-port';

export function createHttpStopPort(options: Readonly<{
  origin: string;
  requestSecret: string;
  fetch?: typeof globalThis.fetch;
}>): BindingStopPort {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  return {
    async stop(channelId) {
      let response: Response;
      try {
        response = await fetcher(`${options.origin}/api/v1/channels/${encodeURIComponent(channelId)}/stop`, {
          method: 'POST',
          credentials: 'same-origin',
          redirect: 'error',
          headers: { 'content-type': 'application/json', accept: 'application/json', [REQUEST_SECRET_HEADER]: options.requestSecret },
          body: JSON.stringify({ v: 1, targets: null }),
        });
      } catch {
        return { kind: 'failed', reason: 'unavailable' };
      }
      if (response.status === 401) return { kind: 'failed', reason: 'session_ended' };
      if (response.status === 403 || response.status === 404) return { kind: 'failed', reason: 'forbidden' };
      if (response.status === 409) return { kind: 'failed', reason: 'rejected' };
      if (response.status !== 200) return { kind: 'failed', reason: 'unavailable' };
      try {
        return decodeStopReply(await response.json()) ?? { kind: 'failed', reason: 'unavailable' };
      } catch {
        return { kind: 'failed', reason: 'unavailable' };
      }
    },
  };
}
