import type { OwnerId } from '@khala/contracts/messaging/index';

export interface TabHandoff {
  isFocused(): boolean;
  request(ownerId: OwnerId): void;
  listen(onRequest: (ownerId: OwnerId) => void, onFocus: () => void): () => void;
}

/** Broadcasts only an owner identifier. The Web Lock remains the authority for store access. */
export function createBrowserTabHandoff(): TabHandoff {
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('khala.device.handoff.v1');
  const tabId = crypto.randomUUID();
  return {
    isFocused: () => document.visibilityState === 'visible' && document.hasFocus(),
    request(ownerId) { channel?.postMessage({ kind: 'request', ownerId, tabId }); },
    listen(onRequest, onFocus) {
      const receive = (event: MessageEvent) => {
        const message = event.data;
        if (message?.kind !== 'request' || typeof message.ownerId !== 'string'
          || typeof message.tabId !== 'string' || message.tabId === tabId) return;
        onRequest(message.ownerId as OwnerId);
      };
      const focus = () => { if (document.visibilityState === 'visible' && document.hasFocus()) onFocus(); };
      channel?.addEventListener('message', receive);
      window.addEventListener('focus', focus);
      document.addEventListener('visibilitychange', focus);
      return () => {
        channel?.removeEventListener('message', receive);
        window.removeEventListener('focus', focus);
        document.removeEventListener('visibilitychange', focus);
        channel?.close();
      };
    },
  };
}
