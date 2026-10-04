import type { OwnerId } from '@khala/contracts/messaging/index';
import { lockName } from '@khala/messaging/browser-device/index';

/** What the browser reports about the owner's device lock. */
export type DeviceLockState = Readonly<{
  /** Some context holds the lock. While this tab holds no lease, that is another tab. */
  held: boolean;
  /** Some context is waiting for the lock. While this tab holds the lease, that is another tab. */
  waiting: boolean;
}>;

export interface TabHandoff {
  isFocused(): boolean;
  request(ownerId: OwnerId): void;
  listen(onRequest: (ownerId: OwnerId) => void, onFocus: () => void): () => void;
  /**
   * Reads the owner's device lock from the browser, or `null` when it cannot be
   * read. The browser drops a lock with the tab that held it, so this never
   * reports a tab that has gone. Focus alone can't show that another tab exists.
   */
  lockState?(ownerId: OwnerId): Promise<DeviceLockState | null>;
}

type LockSnapshot = Readonly<{ held?: readonly Readonly<{ name?: string }>[]; pending?: readonly Readonly<{ name?: string }>[] }>;
type LockQuery = Readonly<{ query?: () => Promise<LockSnapshot> }>;

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
    async lockState(ownerId) {
      const locks = (globalThis.navigator as { locks?: LockQuery } | undefined)?.locks;
      if (typeof locks?.query !== 'function') return null;
      try {
        const snapshot = await locks.query();
        const name = lockName(ownerId);
        return {
          held: (snapshot.held ?? []).some(lock => lock.name === name),
          waiting: (snapshot.pending ?? []).some(lock => lock.name === name),
        };
      } catch {
        return null;
      }
    },
  };
}
