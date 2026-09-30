import { expect, it, vi } from 'vitest';
import type { ParticipantView } from '@khala/contracts/messaging/index';
import type { SubstrateEvent } from '@khala/messaging/channels/index';
import { attachNameTargets } from './name-targets';

const participant = { participantId: 'human_one' as never, ownerId: 'owner_one' as never,
  kind: 'human' as const, displayName: 'Maya', deviceIds: [] };
const text: SubstrateEvent = { kind: 'message', participant, eventId: '$text' as never,
  authorDeviceId: 'DEVICE_ONE' as never, content: { v: 1, kind: 'text', body: 'Readable' }, clientTxnId: null, receivedAt: '2026-09-30T00:00:00Z' };
const rename: SubstrateEvent = { ...text, eventId: '$rename' as never,
  content: { v: 1, kind: 'agent_rename', agentParticipantId: 'agent_missing' as never, body: 'Dolan' } };

it('keeps readable neighbours when one valid name target is unknown or unreadable', async () => {
  const resolve = vi.fn(async () => new Map<string, ParticipantView>());
  const result = await attachNameTargets([text, rename, { ...text, eventId: '$after' as never }], resolve, () => true);
  expect(result.map(event => event.kind)).toEqual(['message', 'message']);
  expect(result[0]).toEqual(text);
  expect(resolve).toHaveBeenCalledExactlyOnceWith('agent_missing');
});

it('reports transient lookup failure without inventing missing encryption keys', async () => {
  await expect(attachNameTargets([text, rename], async () => { throw new Error('unavailable'); }, () => true)).rejects.toThrow('unavailable');
  await expect(attachNameTargets([rename], async () => null, () => true)).rejects.toThrow('target lookup unavailable');
});

it('attaches the authenticated historical target and fences an obsolete session', async () => {
  const target: ParticipantView = { ...participant, participantId: 'agent_missing' as never, kind: 'agent' };
  const resolve = async () => new Map([['@departed:example.test', target]]);
  expect(await attachNameTargets([rename], resolve, () => true)).toMatchObject([{ kind: 'message', targetParticipant: target }]);
  await expect(attachNameTargets([rename], resolve, () => false)).rejects.toThrow('Matrix session changed');
});

it('renders readable messages with ready names after rejecting an unknown or unauthorized target claim', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createTimelineController } = await import('../../features/timeline/controller');
  const { TimelineScreen } = await import('../../features/timeline/TimelineScreen');
  const { toEntry } = await import('@khala/messaging/channels/timeline');
  const roomId = 'room_test' as import('@khala/contracts/messaging/index').RoomId;
  const events = await attachNameTargets([text, rename, { ...text, eventId: '$after' as never }],
    async () => new Map<string, ParticipantView>(), () => true);
  const entries = await Promise.all(events.map(event => toEntry(roomId, event)));
  const page = { items: entries.flatMap(entry => entry.kind === 'message' ? [entry.item] : []),
    unavailableEventIds: entries.flatMap(entry => entry.kind === 'unavailable' ? [entry.eventId] : []),
    nextCursor: null, snapshotRevision: 'rev_1' };
  const port = { observe: () => () => {}, timeline: async () => ({ kind: 'ok' as const, value: page }),
    send: async () => ({ kind: 'unavailable' as const, retryable: true }) } as unknown as import('@khala/contracts/messaging/index').ChannelPort;
  const controller = createTimelineController(port, roomId, { generation: 1 });
  await controller.loadOlder();
  await controller.scanNameHistory?.();
  expect(controller.getSnapshot().namesReady).toBe(true);
  expect(controller.getSnapshot().phase).toBe('ready');
  const html = renderToStaticMarkup(createElement(TimelineScreen, { controller, roomPort: port, roomId, viewer: participant }));
  expect(html.match(/Readable/g)).toHaveLength(2);
  expect(html).not.toContain('Dolan');
  controller.dispose();
});
