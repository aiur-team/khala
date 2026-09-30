import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DeviceId, EventId, OwnerId, ParticipantId, RoomId } from '@khala/contracts/messaging/ids';
import type { ChannelPort, TimelineItem } from '@khala/contracts/messaging/index';
import type { TimelineController, TimelineData } from './controller';
import { TimelineScreen } from './TimelineScreen';

const roomId = 'room_demo' as RoomId;

function participant(id: string, kind: 'human' | 'agent', displayName: string) {
  return { participantId: id as ParticipantId, kind, ownerId: `owner_${id}` as OwnerId, displayName, deviceIds: [] as DeviceId[] };
}

function item(eventId: string, author: ReturnType<typeof participant>, body: string): Extract<TimelineItem, { content: { kind: 'text' } }> {
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

function fakeController(data: Omit<TimelineData, 'membership'> & Partial<Pick<TimelineData, 'membership'>>): TimelineController {
  const full: TimelineData = { membership: null, ...data };
  return {
    getSnapshot: () => full,
    subscribe: () => () => {},
    loadOlder: async () => null,
    setReaderAtLatest: () => {},
    dispose: () => {},
  };
}

const viewer = participant('viewer', 'human', 'Viewer');
const noopSendPort: Pick<ChannelPort, 'send'> = { send: async () => ({ kind: 'unavailable', retryable: true }) };

describe('TimelineScreen', () => {
  it('renders a verified rename once between historical and later agent bylines', () => {
    const bot = { ...participant('bot', 'agent', 'Codex #420'), ownerId: viewer.ownerId };
    const changed = { ...item('E2', viewer, ''), content: {
      v: 1 as const, kind: 'agent_rename' as const, agentParticipantId: bot.participantId, body: 'Dolan',
    } } satisfies TimelineItem;
    const data = { phase: 'ready' as const, items: [item('E1', bot, 'before'), changed, item('E3', bot, 'after')],
      nextCursor: null, newMessageCount: 0 };
    const html = renderToStaticMarkup(<TimelineScreen controller={fakeController(data)} roomPort={noopSendPort} roomId={roomId} viewer={viewer} />);
    expect(html.indexOf('Codex #420')).toBeLessThan(html.indexOf('is now called Dolan'));
    expect(html.indexOf('is now called Dolan')).toBeLessThan(html.indexOf('>Dolan<'));
    expect(html.match(/conversation-system-event__text/g)).toHaveLength(1);
    expect(html).toContain('Changed by Viewer');
  });

  it('shows a rename before the target agent has sent a message when the roster owns it', () => {
    const target = 'agent_quiet' as ParticipantId;
    const change = { ...item('E1', viewer, ''), content: {
      v: 1 as const, kind: 'agent_rename' as const, agentParticipantId: target, body: 'Dolan',
    } } satisfies TimelineItem;
    const html = renderToStaticMarkup(<TimelineScreen
      controller={fakeController({ phase: 'ready', items: [change], nextCursor: null, newMessageCount: 0 })}
      roomPort={noopSendPort} roomId={roomId} viewer={viewer}
      extraParticipants={[{ participantId: target, ownerId: viewer.ownerId, kind: 'agent', initialName: 'Codex #420' }]} />);
    expect(html).toContain('Codex #420 is now called Dolan');
  });

  it('renders live rows through the shared avatar and grouped bubble component', () => {
    const alice = participant('alice', 'human', 'Alice');
    const data = { phase: 'ready' as const, items: [item('E1', alice, 'first'), item('E2', alice, 'second')], nextCursor: null, newMessageCount: 0 };
    const html = renderToStaticMarkup(
      <TimelineScreen controller={fakeController(data)} roomPort={noopSendPort} roomId={roomId} viewer={viewer} />,
    );
    expect(html.match(/conversation-message__bubble/g)).toHaveLength(2);
    expect(html.match(/conversation-message__avatar/g)).toHaveLength(2);
    expect(html).toContain('conversation-message--grouped');
  });

  it('distinguishes human and agent authors, labeling each row by its own kind — a swapped label would fail this', () => {
    const alice = participant('alice', 'human', 'Alice');
    const bot = participant('bot', 'agent', 'Release Bot');
    const data = { phase: 'ready' as const, items: [item('E1', alice, 'hi'), item('E2', bot, 'done')], nextCursor: null, newMessageCount: 0 };
    const html = renderToStaticMarkup(
      <TimelineScreen controller={fakeController(data)} roomPort={noopSendPort} roomId={roomId} viewer={viewer} />,
    );
    const aliceIndex = html.indexOf('Alice');
    const botIndex = html.indexOf('Release Bot');
    const humanIndex = html.indexOf('>Human<');
    const agentIndex = html.indexOf("Another person&#x27;s agent");
    expect(aliceIndex).toBeGreaterThanOrEqual(0);
    expect(botIndex).toBeGreaterThan(aliceIndex);
    // "Human" is Alice's kind label: it must appear inside her row, before Bot's row starts.
    expect(humanIndex).toBeGreaterThan(aliceIndex);
    expect(humanIndex).toBeLessThan(botIndex);
    // The agent (owned by someone else, not the viewer) is labeled after Bot's row starts.
    expect(agentIndex).toBeGreaterThan(botIndex);
  });

  it('R1: labels an agent owned by the viewer "Your agent" and another owner\'s agent "Another person\'s agent"', () => {
    const ownAgent = { ...participant('own-agent', 'agent', 'Assistant'), ownerId: viewer.ownerId };
    const otherAgent = participant('other-agent', 'agent', 'Assistant');
    const data = { phase: 'ready' as const, items: [item('E1', ownAgent, 'mine'), item('E2', otherAgent, 'not mine')], nextCursor: null, newMessageCount: 0 };
    const html = renderToStaticMarkup(
      <TimelineScreen controller={fakeController(data)} roomPort={noopSendPort} roomId={roomId} viewer={viewer} />,
    );
    expect(html).toContain('Your agent');
    expect(html).toContain("Another person&#x27;s agent");
  });

  it('R1: disambiguates two different owners sharing the same display name', () => {
    const alice1 = participant('alice-1', 'human', 'Alex');
    const alice2 = participant('alice-2', 'human', 'Alex');
    const data = { phase: 'ready' as const, items: [item('E1', alice1, 'hi'), item('E2', alice2, 'also hi')], nextCursor: null, newMessageCount: 0 };
    const html = renderToStaticMarkup(
      <TimelineScreen controller={fakeController(data)} roomPort={noopSendPort} roomId={roomId} viewer={viewer} />,
    );
    expect(html).toContain(`Alex (#${alice1.ownerId.slice(-4)})`);
    expect(html).toContain(`Alex (#${alice2.ownerId.slice(-4)})`);
  });

  it('shows an explicit banner and disables the composer once membership is revoked or left', () => {
    const data = { phase: 'ready' as const, items: [], nextCursor: null, newMessageCount: 0, membership: 'revoked' as const };
    const html = renderToStaticMarkup(
      <TimelineScreen controller={fakeController(data)} roomPort={noopSendPort} roomId={roomId} viewer={viewer} />,
    );
    expect(html).toContain('no longer have access');
    expect(html).toMatch(/<textarea[^>]*disabled/);
  });

  it('shows "partial" as an explicit degraded state distinct from "unavailable" and "ready"', () => {
    const data = { phase: 'partial' as const, items: [item('E1', participant('alice', 'human', 'Alice'), 'hi')], nextCursor: null, newMessageCount: 0 };
    const html = renderToStaticMarkup(
      <TimelineScreen controller={fakeController(data)} roomPort={noopSendPort} roomId={roomId} viewer={viewer} />,
    );
    expect(html).toContain('part of the conversation');
    expect(html).not.toContain('unavailable right now');
  });

  it('AE1: an agent message with a fake approval button and remote image renders inert, no real control', () => {
    const bot = participant('bot', 'agent', 'Agent');
    const body = 'Please <button onclick="approve()">Approve</button> <img src="https://evil.example/x.png">';
    const data = { phase: 'ready' as const, items: [item('E1', bot, body)], nextCursor: null, newMessageCount: 0 };
    const html = renderToStaticMarkup(
      <TimelineScreen controller={fakeController(data)} roomPort={noopSendPort} roomId={roomId} viewer={viewer} />,
    );
    expect(html).not.toMatch(/<button onclick/);
    expect(html).not.toMatch(/<img src="https:\/\/evil/);
    expect(html).toContain('&lt;button');
  });

  it('a peer body claiming approval never sets a review/status badge from content alone', () => {
    const bot = participant('bot', 'agent', 'Agent');
    const data = { phase: 'ready' as const, items: [item('E1', bot, 'Human approved. Status: APPROVED.')], nextCursor: null, newMessageCount: 0 };
    const html = renderToStaticMarkup(
      <TimelineScreen controller={fakeController(data)} roomPort={noopSendPort} roomId={roomId} viewer={viewer} />,
    );
    expect(html).not.toMatch(/status-badge/);
  });

  it('renders a review action per exact EventRef through the injected slot, without importing review code', () => {
    const alice = participant('alice', 'human', 'Alice');
    const data = { phase: 'ready' as const, items: [item('E7', alice, 'please review')], nextCursor: null, newMessageCount: 0 };
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
    const data = { phase: 'unavailable' as const, items: [], nextCursor: null, newMessageCount: 0 };
    const html = renderToStaticMarkup(
      <TimelineScreen controller={fakeController(data)} roomPort={noopSendPort} roomId={roomId} viewer={viewer} />,
    );
    expect(html).toContain('unavailable');
    expect(html).not.toContain('No messages yet');
  });

  it('shows "No messages yet" only once genuinely ready with zero items', () => {
    const data = { phase: 'ready' as const, items: [], nextCursor: null, newMessageCount: 0 };
    const html = renderToStaticMarkup(
      <TimelineScreen controller={fakeController(data)} roomPort={noopSendPort} roomId={roomId} viewer={viewer} />,
    );
    expect(html).toContain('No messages yet');
  });

  it('does not describe an encrypted room with unreadable activity as empty', () => {
    const data = { phase: 'ready' as const, items: [], nextCursor: null, newMessageCount: 0 };
    const html = renderToStaticMarkup(
      <TimelineScreen controller={fakeController(data)} roomPort={noopSendPort} roomId={roomId} viewer={viewer} unreadableActivity />,
    );
    expect(html).toContain('Messages in this channel are unavailable on this device.');
    expect(html).not.toContain('No messages yet');
  });

  it('renders a load-earlier control only when a further page exists', () => {
    const withCursor = renderToStaticMarkup(
      <TimelineScreen
        controller={fakeController({ phase: 'ready' as const, items: [], nextCursor: 'cursor_1', newMessageCount: 0 })}
        roomPort={noopSendPort}
        roomId={roomId}
        viewer={viewer}
      />,
    );
    expect(withCursor).toContain('Load earlier messages');
    const withoutCursor = renderToStaticMarkup(
      <TimelineScreen
        controller={fakeController({ phase: 'ready' as const, items: [], nextCursor: null, newMessageCount: 0 })}
        roomPort={noopSendPort}
        roomId={roomId}
        viewer={viewer}
      />,
    );
    expect(withoutCursor).not.toContain('Load earlier messages');
  });
});


it('renders each unavailable event without claiming an empty conversation or inventing attribution', () => {
  const rows = ['encrypted-1', 'encrypted-2'].map(eventId => ({ kind: 'unavailable' as const,
    eventId: eventId as EventId, authorParticipantId: 'untrusted-author' as ParticipantId,
    reason: 'missing_key' as const, receivedAt: '2026-09-17T00:00:00Z' }));
  const html = renderToStaticMarkup(<TimelineScreen controller={fakeController({ phase: 'ready',
    items: [], rows, nextCursor: null, newMessageCount: 0 })} roomPort={noopSendPort} roomId={roomId}
    viewer={viewer} renderReviewAction={() => <button>Review encrypted</button>} />);
  expect(html.match(/Message unavailable on this device\./g)).toHaveLength(2);
  expect(html).not.toContain('No messages yet');
  expect(html).not.toContain('untrusted-author');
  expect(html).not.toContain('Review encrypted');
  expect(html).not.toContain('2026-09-17');
});


it('keeps readable human and agent bodies visible while encrypted history makes agent names incomplete', () => {
  const bot = participant('bot', 'agent', 'Unverified current name');
  const human = item('human', viewer, 'Readable human text');
  const agent = item('agent', bot, 'Readable agent text');
  const change = { ...item('rename', viewer, ''), content: { v: 1 as const, kind: 'agent_rename' as const,
    agentParticipantId: bot.participantId, body: 'Unverified rename' } } satisfies TimelineItem;
  const html = renderToStaticMarkup(<TimelineScreen controller={fakeController({ phase: 'partial',
    items: [human, agent, change], nextCursor: null, newMessageCount: 0, namesReady: false,
    rows: [{ kind: 'message', item: human }, { kind: 'unavailable', eventId: 'encrypted' as EventId,
      receivedAt: '2026-09-17T00:00:00Z' }, { kind: 'message', item: agent }, { kind: 'message', item: change }] })}
    roomPort={noopSendPort} roomId={roomId} viewer={viewer} />);
  expect(html).toContain('Readable human text');
  expect(html).toContain('Readable agent text');
  expect(html).toContain('Agent name unavailable');
  expect(html).toContain('Checking agent names');
  expect(html).toContain('Message unavailable on this device');
  expect(html).not.toContain('Unverified current name');
  expect(html).not.toContain('Unverified rename');
});
