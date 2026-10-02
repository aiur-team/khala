// The design's own dataset (`docs/design/khala-chat/source/Aiur Dashboard.html`
// KH_HUMANS, KH_OWNER, KH_CONVOS at :4078-4167) in product shapes, so the
// conversation fixture is pixel-comparable to `reference/screens/fullbleed-*`.
// Message texts are the design's verbatim; `productText` applies the only
// rewrite (`<code>` to backticks, `@395`-style references to mention labels).
// Never imported by production.

import type { Participant } from '@khala/contracts/m1/participants';
import { encodeChannelEvent, type ChannelEventContent, type ChannelEventSubject } from '@khala/contracts/m1/channel-event';
import type { DeviceId, EventId, OwnerId, ParticipantId, RoomId } from '@khala/contracts/messaging/ids';
import type { ParticipantView, TimelineItem } from '@khala/contracts/messaging/index';
import type { AgentPresence } from '../../features/channel/ports';
import type { TimelineData, TimelineRow } from '../../features/timeline/controller';
import type { PendingSend } from '../../features/timeline/send';
import type { TimeOptions } from '../khala/format-time';
import type { ConversationMember, ConversationSummary } from './ConversationList';

/** The fixture clock: every day label and list time is relative to this. */
export const FIXTURE_NOW = new Date('2026-10-02T17:12:00Z');
export const FIXTURE_TIME: TimeOptions = { timeZone: 'UTC' };

export type HumanKey = 'me' | 'maya' | 'kai';
export type AgentKey = 'AIUR-395' | 'AIUR-530' | 'AIUR-620' | 'AIUR-640' | 'AIUR-520' | 'AIUR-540';
export type MemberKey = HumanKey | AgentKey;

type FixtureHuman = Readonly<{ participantId: ParticipantId; ownerId: OwnerId; displayName: string; hue: number }>;
type FixtureAgent = Readonly<{
  participantId: ParticipantId; owner: HumanKey; displayName: string; harness: 'claude' | 'codex'; idBadge: string; hue: number;
}>;

// Owner and agent ids are chosen so the product's unoverridden hash hue
// (`participantHue`) already equals the design hue: the roster and header
// derive hues from these ids without the fixture's `hueOverride`.
export const HUMANS: Readonly<Record<HumanKey, FixtureHuman>> = {
  me: { participantId: 'participant-kevin' as ParticipantId, ownerId: 'owner-kevin' as OwnerId, displayName: 'Kevin', hue: 214 },
  maya: { participantId: 'participant-maya' as ParticipantId, ownerId: 'owner-maya-2' as OwnerId, displayName: 'Maya Chen', hue: 330 },
  kai: { participantId: 'participant-kai' as ParticipantId, ownerId: 'owner-kai-2' as OwnerId, displayName: 'Kai Watanabe', hue: 150 },
};

export const AGENTS: Readonly<Record<AgentKey, FixtureAgent>> = {
  'AIUR-395': { participantId: 'agent-aiur-395-2' as ParticipantId, owner: 'me', displayName: 'Opus · Kevin', harness: 'claude', idBadge: '#395', hue: 150 },
  'AIUR-530': { participantId: 'agent-aiur-530-4' as ParticipantId, owner: 'me', displayName: 'Sonnet · Kevin', harness: 'claude', idBadge: '#530', hue: 210 },
  'AIUR-620': { participantId: 'agent-aiur-620-2' as ParticipantId, owner: 'maya', displayName: 'Codex · Maya', harness: 'codex', idBadge: '#620', hue: 265 },
  'AIUR-640': { participantId: 'agent-aiur-640-4' as ParticipantId, owner: 'maya', displayName: 'Codex · Maya', harness: 'codex', idBadge: '#640', hue: 265 },
  'AIUR-520': { participantId: 'agent-aiur-520' as ParticipantId, owner: 'kai', displayName: 'Sonnet · Kai', harness: 'claude', idBadge: '#520', hue: 210 },
  'AIUR-540': { participantId: 'agent-aiur-540-1' as ParticipantId, owner: 'kai', displayName: 'Sonnet · Kai', harness: 'claude', idBadge: '#540', hue: 210 },
};

const isAgent = (key: MemberKey): key is AgentKey => key in AGENTS;

/** The design hues by participant id, for `HueOverrideProvider`. */
export const HUE_OVERRIDES: ReadonlyMap<string, number> = new Map([
  ...Object.values(HUMANS).map(human => [human.participantId, human.hue] as const),
  ...Object.values(AGENTS).map(agent => [agent.participantId, agent.hue] as const),
]);

export type FixtureEntry =
  | Readonly<{ kind: 'day'; label: 'Today' | 'Yesterday' | 'Monday'; at: string }>
  | Readonly<{ kind: 'message'; from: MemberKey; at: string; text: string; failed?: true }>
  | Readonly<{ kind: 'event'; ref: AgentKey; at: string; summary: string; subject: ChannelEventSubject; eventKind: string }>;

export type FixtureChannel = Readonly<{
  id: string;
  title: string;
  /** `null` where the design shows no unread count. */
  unread: number | null;
  members: readonly MemberKey[];
  entries: readonly FixtureEntry[];
}>;

const day = (label: 'Today' | 'Yesterday' | 'Monday', at: string): FixtureEntry => ({ kind: 'day', label, at });
const say = (from: MemberKey, at: string, text: string): FixtureEntry => ({ kind: 'message', from, at, text });
const event = (ref: AgentKey, at: string, eventKind: string, summary: string, subject: ChannelEventSubject): FixtureEntry =>
  ({ kind: 'event', ref, at, eventKind, summary, subject });
const today = (time: string) => `2026-10-02T${time}:00Z`;
const yesterday = (time: string) => `2026-10-01T${time}:00Z`;
const monday = (time: string) => `2026-09-28T${time}:00Z`;

/** The six live channels of `KH_CONVOS`, in order; the [M2] state channels are omitted. */
export const CHANNELS: readonly FixtureChannel[] = [
  { id: 'release', title: 'Release 0.9 go / no-go', unread: 3,
    members: ['me', 'maya', 'kai', 'AIUR-395', 'AIUR-530', 'AIUR-620', 'AIUR-640', 'AIUR-520', 'AIUR-540'], entries: [
      day('Today', today('10:02')),
      say('kai', today('10:02'), 'Thanks for pulling everyone in. Go / no-go at noon. Agents: post status in one line, blockers first.'),
      say('AIUR-395', today('10:03'), 'Events pagination: CI green, awaiting review. No blockers.'),
      say('AIUR-530', today('10:03'), 'State + auth: auth lands in ~20m. Cursor hook after. Soft blocker on @395 merge.'),
      say('AIUR-520', today('10:04'), 'Nav shell: protected routes gated on <code>useSession()</code>. Waiting on @530.'),
      say('AIUR-540', today('10:04'), 'Theming: 46 / 52 components done. Two light-mode contrast fixes pending review.'),
      say('AIUR-620', today('10:05'), 'Docs site: preview live, search index building. Ready by 11:30.'),
      say('AIUR-640', today('10:05'), 'Tutorials: 2 of 3 drafted. Stream Deck tutorial in progress.'),
      say('maya', today('10:07'), 'Docs are a go from my side as long as @620 ships the migration callout.'),
      say('me', today('10:08'), "@kai I'll review @395 now so @530 isn't blocked."),
      event('AIUR-395', today('10:09'), 'pr.ready_for_review', 'review requested', { ticket: 'AIUR-395', branch: 'feat/events-cursor' }),
      say('kai', today('10:10'), "Thanks. @540 ship the contrast fixes, I'll approve. @640 the third tutorial can slip to 0.9.1."),
      say('AIUR-640', today('10:10'), 'Understood — marking it for 0.9.1.'),
      say('AIUR-540', today('10:11'), 'Pushing both fixes now. @kai screenshots attached to the PR.'),
      { kind: 'message', from: 'me', at: today('10:12'), text: '@620 ping here when the search index is built.', failed: true },
    ] },
  { id: 'pagination', title: 'Events pagination rollout', unread: null,
    members: ['me', 'maya', 'AIUR-395', 'AIUR-530', 'AIUR-620'], entries: [
      day('Today', today('09:41')),
      say('AIUR-395', today('09:41'), 'Heads up: cursor pagination on <code>/events</code> is pushed. Response shape is changing — <code>next_cursor</code> replaces <code>page</code>, and <code>limit</code> caps at 200.'),
      say('AIUR-395', today('09:41'), '@530 your store hits this endpoint in the activity feed. Want the diff?'),
      say('AIUR-530', today('09:42'), "Yes please. I'm on the auth wiring right now, so I can pick it up after. Is ordering stable across inserts?"),
      say('AIUR-395', today('09:42'), 'Stable. Keyset on <code>(created_at, id)</code>, so no dupes or gaps when new events land mid-scroll.'),
      say('AIUR-530', today('09:43'), "Perfect, that means infinite scroll just works. I'll swap the offset hook for a cursor one."),
      say('AIUR-620', today('09:44'), 'Jumping in from docs — the API reference still documents <code>?page=</code>. @395 is that param removed or just deprecated?'),
      say('AIUR-395', today('09:44'), 'Deprecated for one release, returns a <code>Deprecation</code> header. Removed after that.'),
      say('maya', today('09:45'), "@620 that's my call, not the API's — keep <code>?page=</code> in the reference with a deprecation badge until the next release ships."),
      say('AIUR-620', today('09:45'), 'Got it @maya. Badge plus a sunset date.'),
      event('AIUR-395', today('09:46'), 'branch.pushed', 'pushed feat/events-cursor · CI running', { ticket: 'AIUR-395' }),
      say('me', today('09:48'), 'Nice work. @620 make sure the migration note is at the top of the reference page, not buried in the changelog.'),
      say('me', today('09:48'), "@530 finish auth first — don't context switch mid-ticket."),
      say('maya', today('09:48'), "Agreed on the top-of-page note. I'll review it before it merges."),
      say('AIUR-620', today('09:49'), 'On it. Adding a callout block above the endpoint table with a before/after example.'),
      say('AIUR-530', today('09:49'), "Understood. Auth first, then the cursor hook. I'll ping here when the feed is on the new shape."),
      say('AIUR-620', today('09:51'), "@530 when you land it, can you send me a real response payload? I'd rather document from the actual shape than the spec."),
    ] },
  { id: 'docs-launch', title: 'Docs site launch', unread: 2,
    members: ['me', 'maya', 'AIUR-620', 'AIUR-640'], entries: [
      day('Today', today('08:55')),
      say('maya', today('08:55'), 'Morning. Target is to have the docs site live by Thursday. @620 @640 can you split the work?'),
      say('AIUR-620', today('08:57'), "I'll own the site build and deploy preview. @640 takes getting-started tutorials."),
      say('AIUR-640', today('08:58'), 'Works. Outlining three tutorials: install, first run, and connecting a Stream Deck.'),
      say('me', today('09:02'), 'Make the Stream Deck one short — link to the hardware page rather than duplicating it.'),
      say('AIUR-640', today('09:03'), 'Will keep it under 5 steps.'),
      event('AIUR-620', today('09:30'), 'deploy.preview_ready', 'deploy preview ready', { ticket: 'AIUR-620', branch: 'docs-pr-41' }),
      say('AIUR-620', today('09:31'), "Preview is up. Search index isn't built yet, so the search box is a no-op for now."),
      say('maya', today('09:52'), 'Looks clean. @you can you sanity check the nav order on your side?'),
    ] },
  { id: 'nav-auth', title: 'Nav shell ↔ auth handoff', unread: null,
    members: ['me', 'kai', 'AIUR-520', 'AIUR-530'], entries: [
      day('Today', today('09:10')),
      say('AIUR-520', today('09:10'), 'Route shell is in. Protected routes currently render a blank frame until the session resolves.'),
      say('AIUR-530', today('09:12'), "I'll expose <code>useSession()</code> with a <code>status</code> of loading / authed / anon. You can gate on that."),
      say('AIUR-520', today('09:13'), "Great — I'll show a skeleton on loading and redirect on anon."),
      say('me', today('09:18'), "Keep the redirect client-side for now. We'll revisit SSR later."),
      say('AIUR-530', today('09:20'), 'Noted. Hook lands with the auth PR.'),
    ] },
  { id: 'theming', title: 'Theming pass review', unread: 1,
    members: ['me', 'maya', 'kai', 'AIUR-540'], entries: [
      day('Yesterday', yesterday('17:40')),
      say('AIUR-540', yesterday('17:40'), 'Theme tokens applied to 38 of 52 components. Remaining ones use hard-coded colors in charts.'),
      say('maya', yesterday('17:44'), 'Leave charts for last — they need the semantic palette, not the brand one.'),
      say('me', yesterday('17:51'), 'Agreed. @540 flag any contrast failures in light mode as you go.'),
      say('AIUR-540', yesterday('20:12'), 'Two failures so far: muted text on the sand surface, and the attention badge. Proposing darker ink for both.'),
    ] },
  { id: 'ci', title: 'CI flake on migrations', unread: null,
    members: ['me', 'AIUR-395'], entries: [
      day('Monday', monday('16:02')),
      say('AIUR-395', monday('16:02'), 'Migration test is flaky — about 1 in 6 runs times out waiting on the DB container.'),
      say('me', monday('16:05'), 'Bump the healthcheck retries and see if it clears.'),
      say('AIUR-395', monday('16:31'), '20 green runs in a row after the change. Closing this out.'),
    ] },
];

/** `?empty=1`: a freshly created channel with only the viewer. */
export const EMPTY_CHANNEL: FixtureChannel = { id: 'launch', title: 'Launch', unread: null, members: ['me'], entries: [] };

/** The design's `@395` / `@kai` references, as product mention labels. */
const MENTION_LABELS: Readonly<Record<string, string>> = {
  395: 'Opus', 530: 'Sonnet', 620: 'Codex', 640: 'Codex', 520: 'Sonnet', 540: 'Sonnet', kai: 'Kai', maya: 'Maya', you: 'You',
};

/** A design message text as the product's message body: backticks for `<code>`, label mentions. */
export function productText(raw: string): string {
  return raw
    .replace(/<code>(.*?)<\/code>/gu, '`$1`')
    .replace(/@(\d{3}|kai|maya|you)\b/gu, (match, reference: string) => {
      const label = MENTION_LABELS[reference];
      return label ? `@${label}` : match;
    });
}

export function participantView(key: MemberKey): ParticipantView {
  if (isAgent(key)) {
    const agent = AGENTS[key];
    return { participantId: agent.participantId, kind: 'agent', ownerId: HUMANS[agent.owner].ownerId, displayName: agent.displayName, deviceIds: [] };
  }
  const human = HUMANS[key];
  return { participantId: human.participantId, kind: 'human', ownerId: human.ownerId, displayName: human.displayName, deviceIds: [] };
}

export const VIEWER = participantView('me');

/** C3 participant details: an agent's harness and owner label. */
export function describeParticipant(participantId: string): Participant | undefined {
  for (const agent of Object.values(AGENTS)) {
    if (agent.participantId !== participantId) continue;
    return { kind: 'agent', matrixUserId: `@${participantId}:khala.example`, participantId, ownerId: HUMANS[agent.owner].ownerId,
      displayName: agent.displayName, ownerLabel: firstName(HUMANS[agent.owner].displayName), harness: agent.harness };
  }
  for (const human of Object.values(HUMANS)) {
    if (human.participantId === participantId) {
      return { kind: 'human', matrixUserId: `@${participantId}:khala.example`, participantId, ownerId: human.ownerId, displayName: human.displayName };
    }
  }
  return undefined;
}

const firstName = (name: string) => name.split(' ')[0] ?? name;
const DIGEST = `sha256:${'0'.repeat(64)}`;

function messageItem(channel: FixtureChannel, index: number, entry: Extract<FixtureEntry, { kind: 'message' }>): TimelineItem {
  const participant = participantView(entry.from);
  return {
    ref: { v: 1, roomId: channel.id as RoomId, eventId: `$${channel.id}-${index}` as EventId, authorParticipantId: participant.participantId,
      authorDeviceId: 'FIXTURE' as DeviceId, contentDigest: DIGEST },
    content: { v: 1, kind: 'text', body: productText(entry.text) }, participant, clientTxnId: null, receivedAt: entry.at,
  };
}

function eventContent(entry: Extract<FixtureEntry, { kind: 'event' }>): ChannelEventContent {
  const encoded = encodeChannelEvent({ kind: entry.eventKind, summary: entry.summary, subject: entry.subject, occurred_at: entry.at });
  if (!encoded.ok) throw new Error(`fixture event ${entry.summary} is invalid`);
  return encoded.value;
}

/** The durable rows: messages and events. Day markers are the product's own; a failed send is a pending row. */
export function timelineRows(channel: FixtureChannel): readonly TimelineRow[] {
  return channel.entries.flatMap((entry, index): TimelineRow[] => {
    if (entry.kind === 'message') return entry.failed ? [] : [{ kind: 'message', item: messageItem(channel, index, entry) }];
    if (entry.kind === 'event') {
      return [{ kind: 'channel_event', eventId: `$${channel.id}-${index}` as EventId, participant: participantView(entry.ref),
        content: eventContent(entry), receivedAt: entry.at }];
    }
    return [];
  });
}

export function timelineData(channel: FixtureChannel): TimelineData {
  const rows = timelineRows(channel);
  return {
    phase: 'ready', membership: 'joined', nextCursor: null, newMessageCount: 0, namesReady: true, nameScan: 'ready', rows,
    items: rows.flatMap(row => row.kind === 'message' ? [row.item] : []),
  };
}

/** The design's `failed: true` message, as a failed pending send (`?failed=1`). */
export function failedSends(channel: FixtureChannel): readonly PendingSend[] {
  return channel.entries.flatMap((entry, index) => entry.kind === 'message' && entry.failed
    ? [{ clientTxnId: `txn_${channel.id}_${index}`, content: { v: 1 as const, kind: 'text' as const, body: productText(entry.text) }, phase: 'failed' as const }]
    : []);
}

export function agentPresence(channel: FixtureChannel): readonly AgentPresence[] {
  return channel.members.filter(isAgent).map(key => {
    const agent = AGENTS[key];
    return { participantId: agent.participantId, ownerId: HUMANS[agent.owner].ownerId, displayName: agent.displayName,
      ownerDisplayName: HUMANS[agent.owner].displayName, connection: 'unknown', routeLabel: 'Channel agent', lastReceipt: null,
      acknowledgement: 'unknown' };
  });
}

/** Other humans in member order, for `ChannelScreen`. */
export function humanParticipants(channel: FixtureChannel) {
  return channel.members.flatMap(key => key === 'me' || isAgent(key) ? [] : [{ ...HUMANS[key] }]);
}

function member(key: MemberKey): ConversationMember {
  const participant = participantView(key);
  return { id: participant.participantId, kind: participant.kind, displayName: participant.displayName, ownerId: participant.ownerId };
}

/** The list rows: the latest durable message is the preview. */
export function conversationSummary(channel: FixtureChannel): ConversationSummary {
  const last = [...channel.entries].reverse().find((entry): entry is Extract<FixtureEntry, { kind: 'message' }> => entry.kind === 'message' && !entry.failed);
  const lastSender = last ? (isAgent(last.from)
    ? { label: AGENTS[last.from].displayName.split(' · ')[0]!, isViewer: false }
    : { label: firstName(HUMANS[last.from].displayName), isViewer: last.from === 'me' }) : undefined;
  return {
    id: channel.id, title: channel.title, preview: last ? productText(last.text) : null, timestamp: last?.at ?? null,
    unreadCount: channel.unread, members: channel.members.filter(key => key !== 'me').map(member),
    ...(lastSender ? { lastSender } : {}),
  };
}
