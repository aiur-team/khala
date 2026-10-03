import { ChannelProjection } from '@khala/messaging/channels/timeline';
import { createTimelineController, type TimelineEntriesView } from './controller';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DeviceId, EventId, OwnerId, ParticipantId, RoomId } from '@khala/contracts/messaging/ids';
import type { ChannelPort, TimelineItem } from '@khala/contracts/messaging/index';
import type { TimelineController, TimelineData } from './controller';
import { TimelineScreen } from './TimelineScreen';
import { HumanColorsProvider, resolveHumanColors } from '../../ui/khala/human-colors';
import type { PendingSend } from './send';

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
  it.each([true, false])('renders C3 agent attribution when namesReady is %s', namesReady => {
    const bot = participant('bot', 'agent', 'Legacy bot');
    const html = renderToStaticMarkup(<TimelineScreen controller={fakeController({ phase: 'ready',
      items: [item('E1', bot, 'hello')], nextCursor: null, newMessageCount: 0, namesReady })}
      roomPort={noopSendPort} roomId={roomId} viewer={viewer}
      describeParticipant={id => id === bot.participantId ? { matrixUserId: '@bot:hs', participantId: 'bot', ownerId: bot.ownerId,
        displayName: 'Claude · Kevin', kind: 'agent', ownerLabel: 'Kevin', harness: 'claude' } : undefined} />);
    // The C3 display name keeps only the label; the avatar's owner badge says whose agent it is.
    expect(html).toContain('<b dir="auto">Claude</b><time');
    expect(html).not.toContain('machine');
    expect(html).toContain('class="kh-row agent theirs first timeline__row"');
    expect(html).toMatch(/aria-label="Claude details"><img src="[^"]+" alt=""\/>/);
    expect(html).toContain('>KE</span>');
    expect(html).not.toContain('Your machine');
    expect(html).not.toContain('Agent name unavailable');
  });

  it('renders an unknown member without throwing', () => {
    const unknown = participant('unknown:@stranger:hs', 'human', 'Unknown');
    const html = renderToStaticMarkup(<TimelineScreen controller={fakeController({ phase: 'ready',
      items: [item('E1', unknown, 'hello')], nextCursor: null, newMessageCount: 0 })}
      roomPort={noopSendPort} roomId={roomId} viewer={viewer}
      describeParticipant={() => ({ matrixUserId: '@stranger:hs', displayName: '@stranger:hs', kind: 'unknown' })} />);
    expect(html).toContain('<b dir="auto">Unknown</b>');
    expect(html).toContain('<span class="kh-ini">UN</span>');
    expect(html).not.toMatch(/kh-htag|kh-row agent/);
    expect(html).not.toContain('@stranger:hs');
  });

  it('keeps human markup identical with C3 details', () => {
    const maya = participant('maya', 'human', 'Maya');
    const controller = fakeController({ phase: 'ready', items: [item('E1', maya, 'hi')], nextCursor: null, newMessageCount: 0 });
    const plain = renderToStaticMarkup(<TimelineScreen controller={controller} roomPort={noopSendPort} roomId={roomId} viewer={viewer} />);
    const detailed = renderToStaticMarkup(<TimelineScreen controller={controller} roomPort={noopSendPort} roomId={roomId} viewer={viewer}
      describeParticipant={() => ({ matrixUserId: '@maya:hs', participantId: maya.participantId, ownerId: maya.ownerId, displayName: 'Maya', kind: 'human' })} />);
    expect(detailed).toBe(plain);
  });

  it('renders a verified rename once between historical and later agent bylines', () => {
    const bot = { ...participant('bot', 'agent', 'Codex #420'), ownerId: viewer.ownerId };
    const changed = { ...item('E2', viewer, ''), content: {
      v: 1 as const, kind: 'agent_rename' as const, agentParticipantId: bot.participantId, body: 'Dolan',
    } } satisfies TimelineItem;
    const data = { phase: 'ready' as const, items: [item('E1', bot, 'before'), changed, item('E3', bot, 'after')],
      nextCursor: null, newMessageCount: 0 };
    const html = renderToStaticMarkup(<TimelineScreen controller={fakeController(data)} roomPort={noopSendPort} roomId={roomId} viewer={viewer} />);
    expect(html.indexOf('Codex #420')).toBeLessThan(html.indexOf('is now Dolan'));
    expect(html.indexOf('is now Dolan')).toBeLessThan(html.indexOf('>Dolan<'));
    expect(html.match(/class="kh-ev kh-ev--static"/g)).toHaveLength(1);
    expect(html).toMatch(/<li data-event-id="E2" class="kh-ev kh-ev--static"><i aria-hidden="true"><\/i><span dir="auto">Codex #420 is now Dolan · Viewer · <time dateTime="2026-09-17T00:00:00Z">\d{1,2}:\d{2}<\/time><\/span><\/li>/);
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
    expect(html).toContain('Codex #420 is now Dolan');
  });

  it('renders a run with one name line and a single visible avatar on its last row', () => {
    const alice = participant('alice', 'human', 'Alice');
    const data = { phase: 'ready' as const, items: [item('E1', alice, 'first'), item('E2', alice, 'second'), item('E3', alice, 'third')],
      nextCursor: null, newMessageCount: 0 };
    const html = renderToStaticMarkup(
      <TimelineScreen controller={fakeController(data)} roomPort={noopSendPort} roomId={roomId} viewer={viewer} />,
    );
    expect(html.match(/class="kh-b"/g)).toHaveLength(3);
    expect(html.match(/class="kh-row human (first|mid|last-of) timeline__row"/g)).toEqual([
      'class="kh-row human first timeline__row"', 'class="kh-row human mid timeline__row"', 'class="kh-row human last-of timeline__row"']);
    expect(html.match(/class="kh-name"/g)).toHaveLength(1);
    expect(html.match(/class="kh-av kh-hav ghost"/g)).toHaveLength(2);
    expect(html.match(/<button type="button" class="kh-av kh-hav"/g)).toHaveLength(1);
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
    const humanIndex = html.indexOf('<span class="kh-htag">Human</span>');
    const agentIndex = html.indexOf('aria-label="Release Bot, another person&#x27;s agent');
    expect(aliceIndex).toBeGreaterThanOrEqual(0);
    expect(botIndex).toBeGreaterThan(aliceIndex);
    // The Human tag sits in Alice's row, before Bot's row starts.
    expect(humanIndex).toBeGreaterThan(aliceIndex);
    expect(humanIndex).toBeLessThan(botIndex);
    expect(html).toContain('class="kh-row human first timeline__row"');
    // The agent row is grey (no `.human`/`.me`) and named for its owner relation.
    expect(agentIndex).toBeGreaterThan(humanIndex);
    expect(html).toContain('class="kh-row agent theirs first timeline__row"');
  });

  it('R1: marks the viewer\'s agent `.yours` (no machine tag) without making it a `.me` row', () => {
    const ownAgent = { ...participant('own-agent', 'agent', 'Assistant'), ownerId: viewer.ownerId };
    const otherAgent = { ...participant('other-agent', 'agent', 'Assistant · Maya') };
    const data = { phase: 'ready' as const, items: [item('E1', ownAgent, 'mine'), item('E2', otherAgent, 'not mine')], nextCursor: null, newMessageCount: 0 };
    const html = renderToStaticMarkup(
      <TimelineScreen controller={fakeController(data)} roomPort={noopSendPort} roomId={roomId} viewer={viewer} />,
    );
    expect(html).not.toContain('machine');
    expect(html).toContain('aria-label="Assistant, your agent,');
    expect(html).toContain('aria-label="Assistant, another person&#x27;s agent,');
    expect(html).toMatch(/<li data-event-id="E1" class="kh-row agent yours first/);
    expect(html).toMatch(/<li data-event-id="E2" class="kh-row agent theirs first[^>]*style="--oh:\d+;--ob:#[0-9a-f]{6}"/);
    expect(html).not.toMatch(/class="kh-row me/);
    // §3: the viewer's owner badge reads `YO`, as in the roster and chips.
    expect(html.match(/class="kh-own"[^>]*>([^<]*)</g)?.map(badge => badge.replace(/.*>/u, '').slice(0, -1))).toEqual(['YO', 'MA']);
  });

  it('colours bubbles by the per-viewer human colours (operator request 2026-10-02: per-human colours)', () => {
    const maya = participant('maya', 'human', 'Maya');
    const ownAgent = { ...participant('own-agent', 'agent', 'Assistant'), ownerId: viewer.ownerId };
    const mayaAgent = { ...participant('maya-agent', 'agent', 'Assistant · Maya'), ownerId: maya.ownerId };
    const colors = resolveHumanColors({ viewer: { ownerId: viewer.ownerId, color: 'blue' }, others: [{ ownerId: maya.ownerId, color: 'blue' }] });
    const data = { phase: 'ready' as const, nextCursor: null, newMessageCount: 0, items: [
      item('E1', viewer, 'mine'), item('E2', maya, 'hers'), item('E3', ownAgent, 'my agent'), item('E4', mayaAgent, 'her agent'),
    ] };
    const html = renderToStaticMarkup(<HumanColorsProvider value={colors}>
      <TimelineScreen controller={fakeController(data)} roomPort={noopSendPort} roomId={roomId} viewer={viewer} />
    </HumanColorsProvider>);
    const mayaColor = colors.get(maya.ownerId)!;
    expect(mayaColor.id).not.toBe('blue');
    expect(html).toMatch(/<li data-event-id="E1" class="kh-row me[^"]*"[^>]*style="--hs:#276ecb"/);
    expect(html).toMatch(new RegExp(`<li data-event-id="E2" class="kh-row human[^"]*"[^>]*style="--hb:${mayaColor.bubbleDark};--hb-l:${mayaColor.bubbleLight};--hk:${mayaColor.ink}"`));
    expect(html).toMatch(/<li data-event-id="E3" class="kh-row agent yours[^"]*"[^>]*style="--oh:214;--ob:#276ecb"/);
    expect(html).toMatch(new RegExp(`<li data-event-id="E4" class="kh-row agent theirs[^"]*"[^>]*style="--oh:${mayaColor.hue};--ob:${mayaColor.tint}"`));
  });

  it('marks a colour variant avatar with its tier and swatch', () => {
    const others = Array.from({ length: 10 }, (_, index) => participant(`h${index}`, 'human', `Human ${index}`));
    const colors = resolveHumanColors({ viewer: { ownerId: viewer.ownerId, color: 'red' }, others: others.map(human => ({ ownerId: human.ownerId, color: 'red' as const })) });
    const variant = others.find(human => colors.get(human.ownerId)?.tier === 1)!;
    const data = { phase: 'ready' as const, nextCursor: null, newMessageCount: 0, items: [item('E1', variant, 'hi')] };
    const html = renderToStaticMarkup(<HumanColorsProvider value={colors}>
      <TimelineScreen controller={fakeController(data)} roomPort={noopSendPort} roomId={roomId} viewer={viewer} />
    </HumanColorsProvider>);
    expect(html).toMatch(new RegExp(`class="kh-av kh-hav" style="--oh:0;--hc:${colors.get(variant.ownerId)!.tint}"[^>]*data-kh-tier="1"`));
  });

  it('shows chosen initials on a human\'s avatar and on their agent\'s owner badge, and the viewer\'s own in place of `YO`', () => {
    const kai = participant('kai', 'human', 'Kai Watanabe');
    const kaisAgent = { ...participant('kai-agent', 'agent', 'Scout'), ownerId: kai.ownerId };
    const ownAgent = { ...participant('own-agent', 'agent', 'Assistant'), ownerId: viewer.ownerId };
    const controller = fakeController({ phase: 'ready', items: [item('E1', kai, 'hi'), item('E2', kaisAgent, 'done'), item('E3', ownAgent, 'mine')],
      nextCursor: null, newMessageCount: 0 });
    const describeParticipant = (id: string) => id === kai.participantId
      ? { matrixUserId: '@kai:hs', participantId: id, ownerId: kai.ownerId, displayName: 'Kai Watanabe', kind: 'human' as const, initials: 'ZZ' }
      : id === kaisAgent.participantId
        ? { matrixUserId: '@scout:hs', participantId: id, ownerId: kai.ownerId, displayName: 'Scout', kind: 'agent' as const,
          ownerLabel: 'Kai', harness: 'claude' as const, ownerInitials: 'ZZ' }
        : undefined;
    const badges = (html: string) => html.match(/class="kh-own"[^>]*>([^<]*)</g)?.map(badge => badge.replace(/.*>/u, '').slice(0, -1));
    const humanAvatar = (html: string) => html.match(/<button type="button" class="kh-av kh-hav"[^>]*>(?:<[^>]+>)*([^<]+)</u)?.[1];

    const chosen = renderToStaticMarkup(<TimelineScreen controller={controller} roomPort={noopSendPort} roomId={roomId} viewer={viewer}
      describeParticipant={describeParticipant} />);
    expect(humanAvatar(chosen)).toBe('ZZ');
    expect(badges(chosen)).toEqual(['ZZ', 'YO']);
    // The mention chips (and the autocomplete popup, from the same targets) carry them too.
    expect(chosen).toMatch(/<button type="button" class="kh-chip kh-chip-h"[^>]*><i>ZZ<\/i>@Kai<\/button>/u);

    const own = renderToStaticMarkup(<TimelineScreen controller={controller} roomPort={noopSendPort} roomId={roomId} viewer={viewer}
      viewerInitials="MZ" describeParticipant={describeParticipant} />);
    expect(badges(own)).toEqual(['ZZ', 'MZ']);

    const derived = renderToStaticMarkup(<TimelineScreen controller={controller} roomPort={noopSendPort} roomId={roomId} viewer={viewer} />);
    expect(humanAvatar(derived)).toBe('KW');
    expect(badges(derived)).toEqual(['KW', 'YO']);
  });

  it('R1: disambiguates two different owners sharing the same display name with an id badge', () => {
    const alice1 = participant('alice-1', 'human', 'Alex');
    const alice2 = participant('alice-2', 'human', 'Alex');
    const data = { phase: 'ready' as const, items: [item('E1', alice1, 'hi'), item('E2', alice2, 'also hi')], nextCursor: null, newMessageCount: 0 };
    const html = renderToStaticMarkup(
      <TimelineScreen controller={fakeController(data)} roomPort={noopSendPort} roomId={roomId} viewer={viewer} />,
    );
    expect(html).toContain(`<b dir="auto">Alex</b><span class="kh-id">#${alice1.ownerId.slice(-4)}</span>`);
    expect(html).toContain(`<b dir="auto">Alex</b><span class="kh-id">#${alice2.ownerId.slice(-4)}</span>`);
  });

  it('shows an explicit banner and disables the composer once membership is revoked or left', () => {
    const data = { phase: 'ready' as const, items: [], nextCursor: null, newMessageCount: 0, membership: 'revoked' as const };
    const html = renderToStaticMarkup(
      <TimelineScreen controller={fakeController(data)} roomPort={noopSendPort} roomId={roomId} viewer={viewer} />,
    );
    expect(html).toContain('no longer have access');
    expect(html).toMatch(/<textarea[^>]*disabled/);
  });

  it('keeps partial history readable without a redundant history notice', () => {
    const data = { phase: 'partial' as const, items: [item('E1', participant('alice', 'human', 'Alice'), 'hi')], nextCursor: null, newMessageCount: 0 };
    const html = renderToStaticMarkup(
      <TimelineScreen controller={fakeController(data)} roomPort={noopSendPort} roomId={roomId} viewer={viewer} />,
    );
    expect(html).toContain('hi');
    expect(html).not.toContain('part of the conversation');
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
  expect(html).not.toContain('Checking agent names');
  expect(html).not.toContain('role="status" aria-label="Loading channel"');
  expect(html).toContain('Message unavailable on this device');
  expect(html).not.toContain('Unverified current name');
  expect(html).not.toContain('Unverified rename');
});

it('keeps retry and composing available without a redundant missing-key notice', () => {
  const html = renderToStaticMarkup(<TimelineScreen controller={fakeController({
    phase: 'partial', items: [item('recent', viewer, 'New message')], nextCursor: null,
    newMessageCount: 0, namesReady: false, nameScan: 'unavailable', membership: 'joined',
  })} roomPort={noopSendPort} roomId={roomId} viewer={viewer} />);
  expect(html).not.toContain('open the original profile');
  expect(html).toContain('Retry history');
  expect(html).not.toContain('Checking agent names');
  expect(html).toContain('New message');
  expect(html).not.toContain('textarea disabled');
});

it('keeps the persisted agent name visible during a resume history scan', () => {
  const bot = participant('bot', 'agent', 'Codex');
  const html = renderToStaticMarkup(<TimelineScreen controller={fakeController({
    phase: 'ready', items: [item('before-resume', bot, 'Earlier message')], nextCursor: null,
    newMessageCount: 0, namesReady: false, nameScan: 'checking',
  })} roomPort={noopSendPort} roomId={roomId} viewer={viewer} />);
  expect(html).toContain('Earlier message');
  expect(html).toContain('Codex');
  expect(html).not.toContain('Agent name unavailable');
  expect(html).not.toContain('Checking agent names');
  expect(html).not.toContain('kh-loading');
});

it('shows only a centred, unlabelled spinner while the conversation loads', () => {
  const html = renderToStaticMarkup(<TimelineScreen controller={fakeController({
    phase: 'loading', items: [], nextCursor: null, newMessageCount: 0, namesReady: false, nameScan: 'checking',
  })} roomPort={noopSendPort} roomId={roomId} viewer={viewer} />);
  expect(html).toContain('<div class="kh-loading kh-loading--overlay" role="status" aria-label="Loading channel">'
    + '<span class="kh-spin" aria-hidden="true"></span><span class="sr-only">Loading channel</span></div>');
  expect(html.match(/role="status"/g)).toHaveLength(1);
  expect(html).not.toContain('kh-state-c');
  expect(html).not.toContain('Checking agent names');
});


it('disambiguates unavailable agent names across owners using the displayed fallback', () => {
  const first = { ...participant('first', 'agent', 'First initial name'), ownerId: 'owner_1234' as OwnerId };
  const second = { ...participant('second', 'agent', 'Second initial name'), ownerId: 'owner_5678' as OwnerId };
  const html = renderToStaticMarkup(<TimelineScreen controller={fakeController({ phase: 'partial',
    items: [item('first-event', first, 'first body'), item('second-event', second, 'second body')],
    nextCursor: null, newMessageCount: 0, namesReady: false })}
    roomPort={noopSendPort} roomId={roomId} viewer={viewer} />);
  expect(html).toContain('Agent name unavailable</b><span class="kh-id">#1234</span>');
  expect(html).toContain('Agent name unavailable</b><span class="kh-id">#5678</span>');
  expect(html).not.toContain('First initial name');
  expect(html).not.toContain('Second initial name');
});

describe('channel event rows', () => {
  it('keeps the first keyed pill in timeline order and breaks message grouping', () => {
    const alice = participant('alice', 'human', 'Alice');
    const first = item('A', alice, 'first');
    const second = item('B', alice, 'second');
    const event = { kind: 'channel_event' as const, eventId: '$event' as EventId, participant: alice,
      content: { v: 1 as const, body: 'first event', kind: 'deploy.finished', summary: 'first event', key: 'k',
        occurred_at: '2020-01-01T00:00:00Z' }, receivedAt: first.receivedAt };
    const rows = [{ kind: 'message' as const, item: first }, event,
      { ...event, eventId: '$duplicate' as EventId, content: { ...event.content, summary: 'duplicate event' } },
      { kind: 'message' as const, item: second }];
    const html = renderToStaticMarkup(<TimelineScreen controller={fakeController({ phase: 'ready', items: [first, second],
      rows, nextCursor: null, newMessageCount: 0 })} roomPort={noopSendPort} roomId={roomId} viewer={viewer} />);
    expect(html.match(/class="channel-event-pill"/g)).toHaveLength(1);
    expect(html).toContain('first event');
    expect(html).not.toContain('duplicate event');
    expect(html).not.toMatch(/kh-row human (mid|last-of)/);
    expect(html.indexOf('data-event-id="A"')).toBeLessThan(html.indexOf('data-event-id="$event"'));
    expect(html.indexOf('data-event-id="$event"')).toBeLessThan(html.indexOf('data-event-id="B"'));
  });
  it('groups adjacent messages when malformed events were dropped at decode', () => {
    const alice = participant('alice', 'human', 'Alice');
    const html = renderToStaticMarkup(<TimelineScreen controller={fakeController({ phase: 'ready',
      items: [item('A', alice, 'first'), item('B', alice, 'second')], nextCursor: null, newMessageCount: 0 })}
      roomPort={noopSendPort} roomId={roomId} viewer={viewer} />);
    expect(html).toContain('kh-row human last-of');
    expect(html).not.toContain('class="channel-event-pill"');
  });
});


it('selects the earlier keyed event after history expands the live projection', () => {
  const alice = participant('alice', 'human', 'Alice');
  const projection = new ChannelProjection(roomId, alice, () => '2026-10-01T00:00:00Z');
  const room = { roomId, title: null, membership: 'joined' as const, revision: '1' };
  projection.applyRoom(room);
  let publish!: (view: TimelineEntriesView) => void;
  const port = { ...noopSendPort, observe: () => () => {},
    timeline: async () => ({ kind: 'ok' as const, value: { items: [], nextCursor: null, snapshotRevision: '1' } }),
    observeEntries: (_id: RoomId, listener: typeof publish) => { publish = listener; return () => {}; } } as unknown as ChannelPort
      & { observeEntries: (_id: RoomId, listener: typeof publish) => () => void };
  const controller = createTimelineController(port, roomId, { generation: 1 });
  const event = (id: string) => ({ kind: 'channel_event' as const, eventId: id as EventId, participant: alice,
    content: { v: 1 as const, body: id, kind: 'deploy.finished', summary: id, key: 'same' }, receivedAt: '2026-10-01T00:00:00Z' });
  projection.applyRemote([event('$newer')]);
  publish(projection.entries(1));
  projection.applyRemote([event('$older'), event('$newer')]);
  publish(projection.entries(1));
  const html = renderToStaticMarkup(<TimelineScreen controller={controller} roomPort={noopSendPort} roomId={roomId} viewer={viewer} />);
  expect(html.match(/class="channel-event-pill"/g)).toHaveLength(1);
  expect(html).toContain('data-event-id="$older"');
  expect(html).not.toContain('data-event-id="$newer"');
  controller.dispose();
});

describe('thread design (KM-182)', () => {
  const ready = (items: TimelineItem[]) => fakeController({ phase: 'ready', items, nextCursor: null, newMessageCount: 0 });
  const store = (phase: PendingSend['phase']) => ({ load: () => [{ clientTxnId: 'txn_1', content: { v: 1 as const, kind: 'text' as const, body: 'queued' }, phase }], save: () => {} });

  it('keeps the viewer\'s agent off `.me` and marks only the viewer\'s own messages', () => {
    const ownAgent = { ...participant('own-agent', 'agent', 'Sonnet · Viewer'), ownerId: viewer.ownerId };
    const html = renderToStaticMarkup(<TimelineScreen controller={ready([item('E1', ownAgent, 'agent text'), item('E2', viewer, 'my text')])}
      roomPort={noopSendPort} roomId={roomId} viewer={viewer} />);
    expect(html).toMatch(/<li data-event-id="E1" class="kh-row agent yours first timeline__row"/);
    expect(html).not.toContain('Your machine');
    expect(html).toMatch(/<li data-event-id="E2" class="kh-row me first timeline__row"[^>]*><div class="kh-col"><div class="kh-b">/);
  });

  it('renders exactly one Delivered receipt, right after the viewer\'s last message, and never Read', () => {
    const alice = participant('alice', 'human', 'Alice');
    const html = renderToStaticMarkup(<TimelineScreen controller={ready([item('E1', viewer, 'one'), item('E2', viewer, 'two'), item('E3', alice, 'reply')])}
      roomPort={noopSendPort} roomId={roomId} viewer={viewer} />);
    expect(html.match(/class="kh-rcpt/g)).toHaveLength(1);
    expect(html).toMatch(/data-event-id="E2"[\s\S]*<\/li><li class="kh-rcpt" role="status">Delivered<\/li><li data-event-id="E3"/);
    expect(html).not.toMatch(/>Read</);
  });

  it('marks a failed send with a Retry button and Not sent', () => {
    const html = renderToStaticMarkup(<TimelineScreen controller={ready([])} roomPort={noopSendPort} roomId={roomId} viewer={viewer}
      pendingStore={store('failed')} />);
    expect(html).toMatch(/class="kh-row me first failed timeline__row timeline__row--pending"/);
    expect(html).toContain('<button type="button" class="kh-ib sm kh-retry" aria-label="Retry" data-tip="Retry">');
    expect(html).toContain('<li class="kh-rcpt kh-fail" role="status">Not sent</li>');
    expect(html.match(/class="kh-rcpt/g)).toHaveLength(1);
  });

  it('offers Check delivery for an outcome_unknown send', () => {
    const html = renderToStaticMarkup(<TimelineScreen controller={ready([])} roomPort={noopSendPort} roomId={roomId} viewer={viewer}
      pendingStore={store('outcome_unknown')} />);
    expect(html).toContain('aria-label="Check delivery" data-tip="Check delivery"');
    expect(html).toContain('<li class="kh-rcpt kh-fail" role="status">Delivery unknown</li>');
  });

  it('shows Sending… with a dimmed bubble while a send is pending', () => {
    const accepted = renderToStaticMarkup(<TimelineScreen controller={ready([])} roomPort={noopSendPort} roomId={roomId} viewer={viewer}
      pendingStore={store('accepted')} />);
    expect(accepted).toContain('<li class="kh-rcpt" role="status">Delivered</li>');
    expect(accepted).not.toContain('kh-retry');
  });

  it('separates days before the first message of each local day', () => {
    const later = { ...item('E2', viewer, 'next day'), receivedAt: '2026-09-18T12:00:00Z' };
    const html = renderToStaticMarkup(<TimelineScreen controller={ready([{ ...item('E1', viewer, 'first'), receivedAt: '2026-09-17T12:00:00Z' }, later])}
      roomPort={noopSendPort} roomId={roomId} viewer={viewer} now={() => new Date('2026-09-18T13:00:00Z')} />);
    expect(html.match(/class="kh-day" role="separator"/g)).toHaveLength(2);
    expect(html.indexOf('class="kh-day"')).toBeLessThan(html.indexOf('data-event-id="E1"'));
    expect(html).toMatch(/<li class="kh-day" role="separator"><b>Today<\/b> \d{1,2}:\d{2} ?\s?(AM|PM)<\/li><li data-event-id="E2"/);
  });

  it('shows the empty thread with an Invite button', () => {
    const html = renderToStaticMarkup(<TimelineScreen controller={ready([])} roomPort={noopSendPort} roomId={roomId} viewer={viewer} onInvite={() => {}} />);
    expect(html).toContain('<li class="kh-empty"><b>No messages yet</b><button type="button" class="kh-btn pri">Invite</button></li>');
  });

  it('omits the empty thread\'s Invite button without an invite path', () => {
    const html = renderToStaticMarkup(<TimelineScreen controller={ready([])} roomPort={noopSendPort} roomId={roomId} viewer={viewer} />);
    expect(html).toContain('<li class="kh-empty"><b>No messages yet</b></li>');
  });

  it('renders history-unavailable and access-lost as state cards', () => {
    const unavailable = renderToStaticMarkup(<TimelineScreen controller={fakeController({ phase: 'unavailable', items: [], nextCursor: null, newMessageCount: 0 })}
      roomPort={noopSendPort} roomId={roomId} viewer={viewer} />);
    expect(unavailable).toContain('<div class="kh-state-c timeline__state" role="alert"><b>Conversation history is unavailable right now.</b><button type="button" class="kh-btn">Retry</button></div>');
    const removed = renderToStaticMarkup(<TimelineScreen controller={fakeController({ phase: 'ready', items: [], nextCursor: null, newMessageCount: 0, membership: 'left' })}
      roomPort={noopSendPort} roomId={roomId} viewer={viewer} />);
    expect(removed).toMatch(/class="kh-state-c timeline__state timeline__status--membership" role="alert"><svg[\s\S]*<b>You no longer have access to this conversation.<\/b>/);
  });

  it('renders known @mentions and passes the roster to the composer chips', () => {
    const opus = participant('opus', 'agent', 'Opus · Maya');
    const html = renderToStaticMarkup(<TimelineScreen controller={ready([item('E1', opus, 'hi'), item('E2', viewer, 'thanks @Opus, ping @nobody')])}
      roomPort={noopSendPort} roomId={roomId} viewer={viewer} />);
    expect(html).toMatch(/<span class="kh-mention" style="--mh:\d+" role="button" tabindex="0">@Opus<\/span>/);
    expect(html).toContain('@nobody');
    expect(html).toContain('class="kh-to');
  });
});
