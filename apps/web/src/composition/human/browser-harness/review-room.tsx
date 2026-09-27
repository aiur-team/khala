import { createRoot } from 'react-dom/client';
import type { ApprovalCommand } from '@khala/contracts/delivery/index';
import type { ChannelSnapshot, RoomPort, TimelineItem } from '@khala/contracts/messaging/index';
import type { HumanRouteContext } from '../application';
import { createHumanRoomRenderer } from '../room';
import '../../../features/review/review.css';

const roomId = 'room_1' as never;
const bindingId = 'binding_1' as never;
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const item = (id: string, body: string, character: string): TimelineItem => ({
  ref: { v: 1, roomId, eventId: id as never, authorParticipantId: 'peer_agent' as never,
    authorDeviceId: 'peer_device' as never, contentDigest: digest(character) },
  content: { v: 1, kind: 'text', body },
  participant: { participantId: 'peer_agent' as never, kind: 'agent', ownerId: 'peer_owner' as never,
    displayName: 'Peer agent', deviceIds: ['peer_device' as never] },
  clientTxnId: null, receivedAt: '2026-09-27T00:00:00Z',
});
const items = [item('event_a', 'Withheld A', 'a'), item('event_b', 'Approved B', 'b')];
const snapshot: ChannelSnapshot = { generation: 1, snapshotRevision: 'snapshot_1',
  room: { roomId, title: 'Test channel', membership: 'joined', revision: 'room_1' }, items };
let command: ApprovalCommand | null = null;
const room = {
  observe(_roomId: unknown, listener: (value: ChannelSnapshot) => void) { queueMicrotask(() => listener(snapshot)); return () => undefined; },
  async timeline() { return { kind: 'ok', value: { items, nextCursor: null, generation: 1 } }; },
} as unknown as RoomPort;
const context = { generation: 1, room, principal: { ownerId: 'owner_1' },
  participant: () => ({ participantId: 'human_1', ownerId: 'owner_1', kind: 'human', displayName: 'Owner', deviceIds: [] }),
  identity: { current: async () => ({ kind: 'signed_in', principal: { ownerId: 'owner_1' } }) },
  device: { current: () => ({ state: 'ready', deviceId: 'device_1', generation: 1 }), observe: () => () => undefined },
} as unknown as HumanRouteContext;
const review = {
  async bindings() { return [{ bindingId, generation: 0, agentParticipantId: 'My agent' }]; },
  review: {
    async preview() { return { kind: 'ok' as const, body: { v: 1, bindingId, bindingGeneration: 0,
      policyVersion: 3, pending: items.map(value => value.ref), receipts: [] } }; },
    async approve(value: ApprovalCommand) { command = value; return { kind: 'answered' as const,
      body: { ok: true, releaseIds: ['release_b'] } }; },
  },
};
declare global { interface Window { __roomReviewCommand: () => ApprovalCommand | null } }
window.__roomReviewCommand = () => command;
createRoot(document.getElementById('app')!).render(createHumanRoomRenderer(review)(context,
  { kind: 'channel', path: '/channels/room_1', roomId }));
