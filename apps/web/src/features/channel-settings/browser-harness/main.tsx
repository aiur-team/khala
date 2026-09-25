import { createRoot } from 'react-dom/client';
import type { RoomId } from '@khala/contracts/messaging/index';
import { ChannelSettingsPanel } from '../ChannelSettingsPanel';
import { createFakeCatalog } from '../fakes';

/**
 * Synthetic ports for the browser harness only: an in-memory catalog with no
 * network calls or credentials. `window.__channelSettingsHarness` lets the
 * spec ask what another agent session would list, and inject failures.
 */
const ROOM = '!harness:example.test' as RoomId;
const catalog = createFakeCatalog({ roomId: ROOM, delayMs: 150 });

declare global {
  interface Window {
    __channelSettingsHarness: {
      listFor(requester: { ownerId: string; principal: string }): readonly unknown[];
      setVisibilityCalls(): number;
      failNext(result: 'unavailable'): void;
      bumpRevision(): void;
      revokeOwnership(): void;
    };
  }
}

window.__channelSettingsHarness = {
  listFor: requester => catalog.listFor(requester),
  setVisibilityCalls: () => catalog.calls.setVisibility.length,
  failNext: result => {
    catalog.failNext.push(result);
  },
  bumpRevision: () => catalog.bumpRevision(),
  revokeOwnership: () => catalog.revokeOwnership(),
};

const ports = { settings: catalog.port };

createRoot(document.getElementById('root')!).render(<ChannelSettingsPanel ports={ports} roomId={ROOM} />);
