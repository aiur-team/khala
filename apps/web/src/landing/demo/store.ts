// The splash demo's whole world, in memory: three channels, two humans, three
// agents and the visitor. It feeds the product's own controllers and ports, so
// the demo renders through the real channel, roster and timeline components.
// Nothing leaves the page: no network, no storage, and a reload starts over.

import { encodeChannelEvent } from '@khala/contracts/m1/channel-event';
import type { HumanColorId } from '@khala/contracts/m1/colors';
import type { ListeningMode } from '@khala/contracts/m1/listening-mode';
import { checkName } from '@khala/contracts/m1/names';
import type { Participant } from '@khala/contracts/m1/participants';
import type { DeviceId, EventId, OwnerId, ParticipantId, RoomId } from '@khala/contracts/messaging/ids';
import type { ChannelPort, ParticipantView, TimelineItem } from '@khala/contracts/messaging/index';
import { ok } from '@khala/contracts/messaging/outcomes';
import type { RenameAgentResult } from '../../features/channel/AgentPresencePanel';
import type { AgentPresence, ChannelUiPort } from '../../features/channel/ports';
import type { TimelineController, TimelineData, TimelineRow } from '../../features/timeline/controller';
import type { ConversationMember, ConversationSummary } from '../../ui/conversation/ConversationList';
import { mentionedAgents, NUDGES, nudgeDue, pickLine, repliesFor } from './replies';

type HumanKey = 'guest' | 'maya' | 'kai';
type AgentKey = 'scout' | 'codex' | 'opus';
type MemberKey = HumanKey | AgentKey;

type DemoHuman = Readonly<{ participantId: ParticipantId; ownerId: OwnerId; displayName: string; color: HumanColorId }>;
type DemoAgent = Readonly<{ participantId: ParticipantId; owner: HumanKey; name: string; harness: 'claude' | 'codex' }>;

/** The visitor is a guest human in a colour no one else in the demo wears. */
export const HUMANS: Readonly<Record<HumanKey, DemoHuman>> = {
  guest: { participantId: 'demo-guest' as ParticipantId, ownerId: 'demo-owner-guest' as OwnerId, displayName: 'Guest', color: 'purple' },
  maya: { participantId: 'demo-maya' as ParticipantId, ownerId: 'demo-owner-maya' as OwnerId, displayName: 'Maya Chen', color: 'pink' },
  kai: { participantId: 'demo-kai' as ParticipantId, ownerId: 'demo-owner-kai' as OwnerId, displayName: 'Kai Watanabe', color: 'green' },
};

/** Initial names; Maya's Claude Code agent was renamed to Scout before the visitor arrived. */
export const AGENTS: Readonly<Record<AgentKey, DemoAgent>> = {
  scout: { participantId: 'demo-agent-scout' as ParticipantId, owner: 'maya', name: 'Scout', harness: 'claude' },
  codex: { participantId: 'demo-agent-codex' as ParticipantId, owner: 'kai', name: 'Codex', harness: 'codex' },
  opus: { participantId: 'demo-agent-opus' as ParticipantId, owner: 'guest', name: 'Opus', harness: 'claude' },
};

const INITIAL_MODES: Readonly<Record<AgentKey, ListeningMode>> = { scout: 'sync', codex: 'steer', opus: 'async' };

/** How long an agent takes to answer, by how it listens: Steer is soonest, Async latest. */
export const REPLY_DELAY_MS: Readonly<Record<ListeningMode, number>> = { steer: 900, sync: 1_600, async: 2_600 };
/** How long an agent takes to confirm a listening-mode change. */
export const MODE_CONFIRM_DELAY_MS = 400;

export const WELCOME_CHANNEL = 'welcome';

const isAgent = (key: MemberKey): key is AgentKey => key in AGENTS;
const firstName = (name: string) => name.split(' ')[0] ?? name;
const DIGEST = `sha256:${'0'.repeat(64)}`;

export const VIEWER = participantView('guest');


type Seed =
  | Readonly<{ kind: 'say'; from: MemberKey; minutesAgo: number; text: string }>
  | Readonly<{ kind: 'pill'; about: MemberKey; minutesAgo: number; summary: string }>;

type SeedChannel = Readonly<{ id: string; title: string; unread: number | null; members: readonly MemberKey[]; seed: readonly Seed[] }>;

const say = (from: MemberKey, minutesAgo: number, text: string): Seed => ({ kind: 'say', from, minutesAgo, text });
const pill = (about: MemberKey, minutesAgo: number, summary: string): Seed => ({ kind: 'pill', about, minutesAgo, summary });

/** The seeded channels, newest first. Copy uses the roster's own labels: Steer · interrupts, Sync · next turn, Async · on demand. */
const CHANNELS: readonly SeedChannel[] = [
  { id: WELCOME_CHANNEL, title: 'Welcome to Khala', unread: null, members: ['guest', 'maya', 'kai', 'scout', 'codex', 'opus'], seed: [
    pill('codex', 46, 'Codex joined'),
    pill('scout', 45, 'Claude is now Scout'),
    say('kai', 44, 'Go / no-go for 0.9 at noon. Agents: one line each, blockers first.'),
    say('codex', 43, 'Search index is built, docs are a go. I’m on Steer, so I saw this right after my last tool call.'),
    say('scout', 42, 'Release notes drafted. I’m on Sync, so new messages reach me at the start of my next turn.'),
    say('maya', 40, '@Opus no rush, you’re on Async. Read this whenever you’re ready.'),
    say('opus', 31, 'Caught up. On Async I only read when I choose to.'),
    say('kai', 29, 'This channel is hosted: end-to-end encrypted, the server only relays ciphertext. Want it on one machine? Start a local channel.'),
    pill('guest', 2, 'Guest joined'),
    say('maya', 1, 'Welcome @Guest! @mention any agent and they’ll answer.'),
  ] },
  { id: 'docs', title: 'Docs site launch', unread: 2, members: ['guest', 'maya', 'scout', 'codex'], seed: [
    say('maya', 95, 'Docs go live Thursday. @Codex @Scout can you split the work?'),
    say('codex', 94, 'I’ll own the site build and the preview deploy.'),
    say('scout', 93, 'Tutorials are mine: install, first run and inviting an agent.'),
  ] },
  { id: 'local', title: 'Local refactor', unread: 1, members: ['guest', 'opus'], seed: [
    pill('opus', 130, 'Opus joined'),
    say('opus', 129, 'This channel is local: no sign-in, no Khala servers, and messages stay on this machine.'),
    say('opus', 128, 'My model provider still sees what I read, so keep secrets out of the thread.'),
  ] },
];

export function participantView(key: MemberKey, names?: Readonly<Record<string, string>>): ParticipantView {
  if (isAgent(key)) {
    const agent = AGENTS[key];
    return { participantId: agent.participantId, kind: 'agent', ownerId: HUMANS[agent.owner].ownerId,
      displayName: names?.[agent.participantId] ?? agent.name, deviceIds: [] };
  }
  const human = HUMANS[key];
  return { participantId: human.participantId, kind: 'human', ownerId: human.ownerId, displayName: human.displayName, deviceIds: [] };
}

function keyOf(participantId: string): MemberKey | undefined {
  return ([...Object.keys(HUMANS), ...Object.keys(AGENTS)] as MemberKey[])
    .find(key => (isAgent(key) ? AGENTS[key] : HUMANS[key]).participantId === participantId);
}

export type DemoOptions = Readonly<{
  /** Returns [0, 1); picks reply lines and which agent nudges. */
  random?: () => number;
  now?: () => Date;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}>;

export type Demo = ReturnType<typeof createDemo>;

export function createDemo(options: DemoOptions = {}) {
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => new Date());
  const setTimer = options.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const started = now().getTime();
  const listeners = new Set<() => void>();
  const timers = new Set<unknown>();
  const names: Record<string, string> = Object.fromEntries(Object.values(AGENTS).map(agent => [agent.participantId, agent.name]));
  const modes: Record<string, ListeningMode> = Object.fromEntries((Object.keys(AGENTS) as AgentKey[])
    .map(key => [AGENTS[key].participantId, INITIAL_MODES[key]]));
  const rows = new Map<string, TimelineRow[]>();
  const unread = new Map<string, number | null>();
  const views = new Map<string, TimelineData>();
  const timelineListeners = new Map<string, Set<() => void>>();
  const presenceListeners = new Map<string, Set<Parameters<ChannelUiPort['subscribeAgents']>[1]>>();
  let sequence = 0;
  let version = 0;
  let open = WELCOME_CHANNEL;
  let lastLine: string | null = null;
  let unmentioned = 0;
  let disposed = false;

  const at = (minutesAgo: number) => new Date(started - minutesAgo * 60_000).toISOString();
  const channelOf = (id: string) => {
    const found = CHANNELS.find(channel => channel.id === id);
    if (!found) throw new Error(`demo: unknown channel ${id}`);
    return found;
  };

  function messageRow(channelId: string, author: ParticipantView, body: string, receivedAt: string, clientTxnId: string | null = null): TimelineRow {
    sequence += 1;
    const item: TimelineItem = {
      ref: { v: 1, roomId: channelId as RoomId, eventId: `$demo-${sequence}` as EventId, authorParticipantId: author.participantId,
        authorDeviceId: 'DEMO' as DeviceId, contentDigest: DIGEST },
      content: { v: 1, kind: 'text', body }, participant: author, clientTxnId, receivedAt,
    };
    return { kind: 'message', item };
  }

  function pillRow(about: ParticipantView, summary: string, receivedAt: string): TimelineRow {
    sequence += 1;
    const content = encodeChannelEvent({ kind: 'member', summary, status: 'info', source: { system: 'khala' } });
    if (!content.ok) throw new Error(`demo: invalid event ${summary}`);
    return { kind: 'channel_event', eventId: `$demo-${sequence}` as EventId, participant: about, content: content.value, receivedAt };
  }

  for (const channel of CHANNELS) {
    rows.set(channel.id, channel.seed.map(entry => entry.kind === 'say'
      ? messageRow(channel.id, participantView(entry.from), entry.text, at(entry.minutesAgo))
      : pillRow(participantView(entry.about), entry.summary, at(entry.minutesAgo))));
    unread.set(channel.id, channel.unread);
  }

  function changed(channelId: string | null): void {
    version += 1;
    if (channelId) {
      views.delete(channelId);
      for (const listener of timelineListeners.get(channelId) ?? []) listener();
    }
    for (const listener of listeners) listener();
  }

  function publishPresence(): void {
    for (const [channelId, set] of presenceListeners) {
      const snapshot = presenceSnapshot(channelId);
      for (const listener of set) listener(snapshot);
    }
  }

  function append(channelId: string, row: TimelineRow): void {
    rows.get(channelId)!.push(row);
    if (channelId !== open && row.kind === 'message' && row.item.participant.participantId !== VIEWER.participantId) unread.set(channelId, (unread.get(channelId) ?? 0) + 1);
    changed(channelId);
  }

  function later(run: () => void, ms: number): void {
    const timer = setTimer(() => {
      timers.delete(timer);
      if (!disposed) run();
    }, ms);
    timers.add(timer);
  }

  function agentsIn(channelId: string): readonly AgentKey[] {
    return channelOf(channelId).members.filter(isAgent);
  }

  function reply(channelId: string, key: AgentKey, lines: readonly string[], delay: number): void {
    const text = pickLine(lines, lastLine, random);
    lastLine = text;
    later(() => append(channelId, messageRow(channelId, participantView(key, names), text, now().toISOString())), delay);
  }

  /** The visitor's message lands at once; mentioned agents answer after a delay that follows their listening mode. */
  function send(channelId: string, clientTxnId: string, body: string): TimelineItem {
    const row = messageRow(channelId, VIEWER, body, now().toISOString(), clientTxnId);
    append(channelId, row);
    const agents = agentsIn(channelId);
    const mentioned = mentionedAgents(body, agents.map(key => ({ participantId: AGENTS[key].participantId, label: names[AGENTS[key].participantId]! })));
    if (mentioned.length > 0) {
      mentioned.forEach((participantId, index) => {
        const key = agents.find(agent => AGENTS[agent].participantId === participantId)!;
        reply(channelId, key, repliesFor(modes[participantId]!), REPLY_DELAY_MS[modes[participantId]!] + index * 700);
      });
    } else {
      unmentioned += 1;
      if (nudgeDue(unmentioned)) reply(channelId, agents[Math.floor(random() * agents.length)]!, NUDGES, REPLY_DELAY_MS.steer);
    }
    return (row as Extract<TimelineRow, { kind: 'message' }>).item;
  }

  function timelineData(channelId: string): TimelineData {
    const cached = views.get(channelId);
    if (cached) return cached;
    const list = [...rows.get(channelId)!];
    const data: TimelineData = { phase: 'ready', membership: 'joined', nextCursor: null, newMessageCount: 0, namesReady: true, nameScan: 'ready',
      rows: list, items: list.flatMap(row => row.kind === 'message' ? [row.item] : []) };
    views.set(channelId, data);
    return data;
  }

  function presenceSnapshot(channelId: string) {
    return { generation: 1, agents: agentsIn(channelId).map((key): AgentPresence => {
      const agent = AGENTS[key];
      return { participantId: agent.participantId, ownerId: HUMANS[agent.owner].ownerId, displayName: names[agent.participantId]!,
        ownerDisplayName: HUMANS[agent.owner].displayName, connection: 'connected', routeLabel: 'Channel agent', lastReceipt: null,
        acknowledgement: 'unknown' };
    }) };
  }

  function member(key: MemberKey): ConversationMember {
    const view = participantView(key, names);
    return { id: view.participantId, kind: view.kind, displayName: view.displayName, ownerId: view.ownerId,
      ...(isAgent(key) ? { harness: AGENTS[key].harness } : {}) };
  }

  return {
    channels: CHANNELS.map(channel => channel.id),
    version: () => version,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    title: (channelId: string) => channelOf(channelId).title,
    /** The list rows, newest activity first; the latest message is the preview. */
    summaries(): readonly ConversationSummary[] {
      return CHANNELS.map((channel): ConversationSummary => {
        const items = timelineData(channel.id).items;
        const last = items.at(-1);
        const lastKey = last ? keyOf(last.participant.participantId) : undefined;
        return { id: channel.id, title: channel.title, preview: last && last.content.kind === 'text' ? last.content.body : null,
          timestamp: last?.receivedAt ?? null, unreadCount: unread.get(channel.id) || null,
          members: channel.members.filter(key => key !== 'guest').map(member),
          ...(last && lastKey ? { lastSender: { label: isAgent(lastKey) ? names[AGENTS[lastKey].participantId]! : firstName(HUMANS[lastKey].displayName),
            isViewer: lastKey === 'guest' } } : {}) };
      }).sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));
    },
    /** Opening a channel reads it. */
    open(channelId: string): void {
      open = channelId;
      unread.set(channelId, null);
      changed(null);
    },
    members: (channelId: string) => channelOf(channelId).members.map(key => participantView(key, names)),
    humanParticipants: (channelId: string) => channelOf(channelId).members.flatMap(key => key === 'guest' || isAgent(key) ? []
      : [{ participantId: HUMANS[key].participantId, ownerId: HUMANS[key].ownerId, displayName: HUMANS[key].displayName }]),
    describeParticipant(participantId: string): Participant | undefined {
      const key = keyOf(participantId);
      if (!key) return undefined;
      if (isAgent(key)) {
        const owner = HUMANS[AGENTS[key].owner];
        return { kind: 'agent', matrixUserId: `@${participantId}:khala.demo`, participantId, ownerId: owner.ownerId, displayName: names[participantId]!,
          ownerLabel: firstName(owner.displayName), harness: AGENTS[key].harness, ownerColor: owner.color };
      }
      const human = HUMANS[key];
      return { kind: 'human', matrixUserId: `@${participantId}:khala.demo`, participantId, ownerId: human.ownerId, displayName: human.displayName, color: human.color };
    },
    modeFor: (participantId: string): ListeningMode => modes[participantId] ?? 'sync',
    /** The agent confirms shortly, as a live agent echoes its new member state. */
    async setMode(participantId: string, mode: ListeningMode): Promise<'sent'> {
      later(() => {
        modes[participantId] = mode;
        changed(null);
      }, MODE_CONFIRM_DELAY_MS);
      return 'sent';
    },
    /** Renames one of the visitor's agents, with the product's name rules, and posts the "is now" pill where it is a member. */
    async rename(participantId: string, name: string): Promise<RenameAgentResult> {
      const key = keyOf(participantId);
      if (!key || !isAgent(key) || AGENTS[key].owner !== 'guest') return { kind: 'error', code: 'not_owner' };
      const checked = checkName(name, 'agent');
      if (!checked.ok) return { kind: 'error', code: 'invalid_name', reason: checked.error };
      const before = names[participantId]!;
      const taken = Object.entries(names).some(([id, other]) => id !== participantId && other.toLowerCase() === checked.name.toLowerCase())
        || Object.values(HUMANS).some(human => firstName(human.displayName).toLowerCase() === checked.name.toLowerCase());
      if (taken) return { kind: 'error', code: 'name_taken' };
      if (before === checked.name) return { kind: 'ok', name: checked.name };
      names[participantId] = checked.name;
      for (const channel of CHANNELS) {
        if (channel.members.includes(key)) append(channel.id, pillRow(participantView(key, names), `${before} is now ${checked.name}`, now().toISOString()));
      }
      publishPresence();
      return { kind: 'ok', name: checked.name };
    },
    timeline(channelId: string): TimelineController {
      return {
        getSnapshot: () => timelineData(channelId),
        subscribe(listener) {
          const set = timelineListeners.get(channelId) ?? new Set();
          set.add(listener);
          timelineListeners.set(channelId, set);
          return () => set.delete(listener);
        },
        loadOlder: async () => null,
        setReaderAtLatest: () => undefined,
        dispose: () => undefined,
      };
    },
    /** The composer's port: the send is accepted at once and never leaves the page. */
    port(channelId: string): Pick<ChannelPort, 'send'> {
      return {
        send: async ({ clientTxnId, content }) => {
          const item = send(channelId, clientTxnId, content.body);
          return ok({ clientTxnId, state: 'accepted' as const, eventRef: { ...item.ref, contentDigest: DIGEST } });
        },
      };
    },
    presence(channelId: string): ChannelUiPort {
      return {
        agents: async () => presenceSnapshot(channelId),
        subscribeAgents(_roomId, listener) {
          const set = presenceListeners.get(channelId) ?? new Set();
          set.add(listener);
          presenceListeners.set(channelId, set);
          return () => set.delete(listener);
        },
        installCommand: async () => { throw new Error('demo agents are already connected'); },
      };
    },
    send,
    dispose(): void {
      disposed = true;
      for (const timer of timers) clearTimer(timer);
      timers.clear();
      listeners.clear();
    },
  };
}
