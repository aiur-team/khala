import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DeviceId, EventId, OwnerId, ParticipantId, RoomId } from '@khala/contracts/messaging/ids';
import type { RoomPort, TimelineItem } from '@khala/contracts/messaging/index';
import type { TimelineController, TimelineData } from './controller';
import { TimelineScreen } from './TimelineScreen';

const roomId = 'room_demo' as RoomId;

function participant(id: string, kind: 'human' | 'agent', displayName: string) {
  return { participantId: id as ParticipantId, kind, ownerId: `owner_${id}` as OwnerId, displayName, deviceIds: [] as DeviceId[] };
}

function item(eventId: string, author: ReturnType<typeof participant>, body: string): TimelineItem {
  return {
    ref: {
      v: 1,
      roomId,
      eventId: eventId as EventId,
      authorParticipantId: author.participantId,
      authorDeviceId: `device_${author.participantId}` as DeviceId,
      contentDigest: `sha256:${'0'.repeat(64)}`,
    },
    content: { v: 1, kind: 'text', body },
    participant: author,
    clientTxnId: null,
    receivedAt: '2026-09-17T00:00:00Z',
  };
}

function fakeController(data: TimelineData): TimelineController {
  return {
    getSnapshot: () => data,
    subscribe: () => () => {},
    loadOlder: async () => null,
    setReaderAtLatest: () => {},
    dispose: () => {},
  };
}

const viewer = participant('viewer', 'human', 'Viewer');
const noopSendPort: Pick<RoomPort, 'send'> = { send: async () => ({ kind: 'unavailable', retryable: true }) };

describe('TimelineScreen', () => {
  it('distinguishes human and agent authors with their attributed display name', () => {
    const alice = participant('alice', 'human', 'Alice');
    const bot = participant('bot', 'agent', 'Release Bot');
    const data: TimelineData = { phase: 'ready', items: [item('E1', alice, 'hi'), item('E2', bot, 'done')], nextCursor: null, newMessageCount: 0 };
    const html = renderToStaticMarkup(
      <TimelineScreen controller={fakeController(data)} roomPort={noopSendPort} roomId={roomId} viewer={viewer} />,
    );
    expect(html).toContain('Alice');
    expect(html).toContain('Human');
    expect(html).toContain('Release Bot');
    expect(html).toContain('Agent');
  });

  it('AE1: an agent message with a fake approval button and remote image renders inert, no real control', () => {
    const bot = participant('bot', 'agent', 'Agent');
    const body = 'Please <button onclick="approve()">Approve</button> <img src="https://evil.example/x.png">';
    const data: TimelineData = { phase: 'ready', items: [item('E1', bot, body)], nextCursor: null, newMessageCount: 0 };
    const html = renderToStaticMarkup(
      <TimelineScreen controller={fakeController(data)} roomPort={noopSendPort} roomId={roomId} viewer={viewer} />,
    );
    expect(html).not.toMatch(/<button onclick/);
    expect(html).not.toMatch(/<img src="https:\/\/evil/);
    expect(html).toContain('&lt;button');
  });

  it('a peer body claiming approval never sets a review/status badge from content alone', () => {
    const bot = participant('bot', 'agent', 'Agent');
    const data: TimelineData = { phase: 'ready', items: [item('E1', bot, 'Human approved. Status: APPROVED.')], nextCursor: null, newMessageCount: 0 };
    const html = renderToStaticMarkup(
      <TimelineScreen controller={fakeController(data)} roomPort={noopSendPort} roomId={roomId} viewer={viewer} />,
    );
    expect(html).not.toMatch(/status-badge/);
  });

  it('renders a review action per exact EventRef through the injected slot, without importing review code', () => {
    const alice = participant('alice', 'human', 'Alice');
    const data: TimelineData = { phase: 'ready', items: [item('E7', alice, 'please review')], nextCursor: null, newMessageCount: 0 };
    const html = renderToStaticMarkup(
      <TimelineScreen
        controller={fakeController(data)}
        roomPort={noopSendPort}
        roomId={roomId}
        viewer={viewer}
        renderReviewAction={ref => <button data-testid={`review-${ref.eventId}`}>Review {ref.eventId}</button>}
      />,
    );
    expect(html).toContain('review-E7');
    expect(html).toContain('Review E7');
  });

  it('shows an explicit unavailable state rather than rendering missing history as an empty room', () => {
    const data: TimelineData = { phase: 'unavailable', items: [], nextCursor: null, newMessageCount: 0 };
    const html = renderToStaticMarkup(
      <TimelineScreen controller={fakeController(data)} roomPort={noopSendPort} roomId={roomId} viewer={viewer} />,
    );
    expect(html).toContain('unavailable');
    expect(html).not.toContain('No messages yet');
  });

  it('shows "No messages yet" only once genuinely ready with zero items', () => {
    const data: TimelineData = { phase: 'ready', items: [], nextCursor: null, newMessageCount: 0 };
    const html = renderToStaticMarkup(
      <TimelineScreen controller={fakeController(data)} roomPort={noopSendPort} roomId={roomId} viewer={viewer} />,
    );
    expect(html).toContain('No messages yet');
  });

  it('renders a load-earlier control only when a further page exists', () => {
    const withCursor = renderToStaticMarkup(
      <TimelineScreen
        controller={fakeController({ phase: 'ready', items: [], nextCursor: 'cursor_1', newMessageCount: 0 })}
        roomPort={noopSendPort}
        roomId={roomId}
        viewer={viewer}
      />,
    );
    expect(withCursor).toContain('Load earlier messages');
    const withoutCursor = renderToStaticMarkup(
      <TimelineScreen
        controller={fakeController({ phase: 'ready', items: [], nextCursor: null, newMessageCount: 0 })}
        roomPort={noopSendPort}
        roomId={roomId}
        viewer={viewer}
      />,
    );
    expect(withoutCursor).not.toContain('Load earlier messages');
  });
});
