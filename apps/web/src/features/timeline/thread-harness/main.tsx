import { createRoot } from 'react-dom/client';
import type { DeviceId, EventId, OwnerId, ParticipantId, RoomId } from '@khala/contracts/messaging/ids';
import type { Participant } from '@khala/contracts/m1/participants';
import type { ChannelPort, ParticipantView, TimelineItem } from '@khala/contracts/messaging/index';
import { KhalaApp } from '../../../ui/khala/KhalaApp';
import { HueOverrideProvider } from '../../../ui/khala/identity';
import type { TimelineController, TimelineData } from '../controller';
import { TimelineScreen } from '../TimelineScreen';

// The design's worked example (RECREATION-SPEC §7) with synthetic people only:
// two agent rows, a viewer message, then a failed send for the receipt.
const roomId = 'room_thread' as RoomId;
const person = (id: string, kind: 'human' | 'agent', displayName: string, ownerId: string): ParticipantView =>
  ({ participantId: id as ParticipantId, ownerId: ownerId as OwnerId, kind, displayName, deviceIds: [] as DeviceId[] });
const viewer = person('p-kevin', 'human', 'Kevin', 'o-kevin');
const sonnet = person('a-sonnet', 'agent', 'Sonnet · Kevin', 'o-kevin');
const maya = person('p-maya', 'human', 'Maya Chen', 'o-maya');

const at = (minute: number) => {
  const date = new Date();
  date.setHours(10, minute, 0, 0);
  return date.toISOString();
};
const message = (eventId: string, author: ParticipantView, body: string, minute: number): TimelineItem => ({
  ref: { v: 1, roomId, eventId: eventId as EventId, authorParticipantId: author.participantId,
    authorDeviceId: 'DEVICE' as DeviceId, contentDigest: `sha256:${'0'.repeat(64)}` },
  content: { v: 1, kind: 'text', body }, participant: author, clientTxnId: null, receivedAt: at(minute),
});

const data: TimelineData = {
  phase: 'ready', membership: 'joined', nextCursor: null, newMessageCount: 0,
  items: [
    message('E1', sonnet, 'State + auth lands in ~20m.', 3),
    message('E2', sonnet, 'Soft blocker on @Maya merge, see `useSession()`.', 4),
    message('E3', maya, 'Thanks, @Sonnet.', 6),
    message('E4', viewer, 'I’ll review it now.', 8),
  ],
};
const controller: TimelineController = {
  getSnapshot: () => data, subscribe: () => () => {}, loadOlder: async () => null, setReaderAtLatest: () => {}, dispose: () => {},
};
const port: Pick<ChannelPort, 'send'> = { send: async () => ({ kind: 'unavailable', retryable: true }) };
const failed = { load: () => [{ clientTxnId: 'txn_failed', content: { v: 1 as const, kind: 'text' as const, body: 'Merged?' }, phase: 'failed' as const }], save: () => {} };

const params = new URLSearchParams(window.location.search);

// `?initials`: Maya has chosen `ZZ` and replies through her own agent; the viewer has chosen `KV`.
// The design's example (no parameter) has no chosen initials.
const chosen = params.has('initials');
const codex = person('a-codex', 'agent', 'Codex · Maya', 'o-maya');
const chosenData: TimelineData = { ...data, items: [...data.items, message('E5', codex, 'Tests are green on my side.', 9)] };
const describeParticipant = (participantId: string): Participant | undefined => {
  if (participantId === maya.participantId) return { matrixUserId: '@maya:khala.local', participantId, ownerId: maya.ownerId,
    displayName: maya.displayName, kind: 'human', initials: 'ZZ' };
  if (participantId === codex.participantId) return { matrixUserId: '@codex:khala.local', participantId, ownerId: maya.ownerId,
    displayName: 'Codex', kind: 'agent', ownerLabel: 'Maya', harness: 'codex', ownerInitials: 'ZZ' };
  return undefined;
};
const chosenController: TimelineController = { ...controller, getSnapshot: () => chosenData };

createRoot(document.getElementById('root')!).render(
  <HueOverrideProvider hues={new Map([['a-sonnet', 150]])}>
    <KhalaApp theme={params.get('theme') === 'light' ? 'light' : 'dark'} inThread
      main={chosen
        ? <TimelineScreen controller={chosenController} roomPort={port} roomId={roomId} viewer={viewer} viewerInitials="KV"
          describeParticipant={describeParticipant} pendingStore={failed} />
        : <TimelineScreen controller={controller} roomPort={port} roomId={roomId} viewer={viewer} pendingStore={failed} />} />
  </HueOverrideProvider>,
);
