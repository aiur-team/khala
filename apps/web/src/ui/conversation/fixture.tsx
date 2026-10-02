import { useEffect, useMemo, useRef, useState } from 'react';
import { decodeContentLimits, type ChannelPort, type RoomId } from '@khala/contracts/messaging/index';
import { ChannelScreen } from '../../features/channel/ChannelScreen';
import { ChannelAddAgent, ChannelInvite } from '../../features/channel/ChannelSharePanel';
import { createChannelController } from '../../features/channel/controller';
import type { ChannelUiPort } from '../../features/channel/ports';
import type { TimelineController } from '../../features/timeline/controller';
import { renderMessageContent } from '../../features/timeline/message-renderer';
import { TimelineScreen, type TimelineComposerHandle } from '../../features/timeline/TimelineScreen';
import type { ThemeChoice } from '../../shell/types';
import { PlusIcon } from '../khala/icons';
import { HueOverrideProvider } from '../khala/identity';
import { KhalaApp } from '../khala/KhalaApp';
import { NewChannelPopover, type NewChannelPorts } from '../khala/NewChannelPopover';
import { ConversationList } from './ConversationList';
import {
  AGENT_MODES, AGENTS, CHANNELS, conversationSummary, describeParticipant, EMPTY_CHANNEL, failedSends, FIXTURE_NOW, FIXTURE_TIME, HUE_OVERRIDES,
  HUMANS, humanParticipants, agentPresence, channelMembers, timelineData, VIEWER, type FixtureChannel,
} from './fixture-data';

/**
 * The design-parity fixture (RECREATION-SPEC §25): the product components with
 * the design's dataset. Query parameters select the state:
 * `theme=dark|light`, `view=list|thread`, `roster=1`, `chips=1`,
 * `detail=<participantId or design key>`, `pop=new|invite|add-agent`,
 * `failed=1`, `empty=1`, `draft=<text>`. Never imported by production.
 */
type FixtureParams = Readonly<{
  theme: ThemeChoice; view: 'list' | 'thread'; roster: boolean; chips: boolean; detail: string | null;
  pop: 'new' | 'invite' | 'add-agent' | null; failed: boolean; empty: boolean; draft: string | null;
}>;

export function readFixtureParams(search: string): FixtureParams {
  const params = new URLSearchParams(search);
  const pop = params.get('pop');
  return {
    theme: params.get('theme') === 'light' ? 'light' : 'dark',
    view: params.get('view') === 'list' ? 'list' : 'thread',
    roster: params.get('roster') === '1', chips: params.get('chips') === '1', detail: params.get('detail'),
    pop: pop === 'new' || pop === 'invite' || pop === 'add-agent' ? pop : null,
    failed: params.get('failed') === '1', empty: params.get('empty') === '1', draft: params.get('draft'),
  };
}

/** `detail=` takes a participant id or a design key (`maya`, `AIUR-395`). */
function detailParticipant(value: string): string {
  if (value in HUMANS) return HUMANS[value as keyof typeof HUMANS].participantId;
  if (value in AGENTS) return AGENTS[value as keyof typeof AGENTS].participantId;
  return value;
}

const limits = (() => {
  const decoded = decodeContentLimits({ maxBodyBytes: 32_768, maxDisplayNameBytes: 255, maxRoomTitleBytes: 255 });
  if (!decoded.ok) throw new Error('invalid fixture limits');
  return decoded.value;
})();
const unavailable = async () => ({ kind: 'unavailable' as const, retryable: true as const });
const newChannelPorts: NewChannelPorts = { room: { create: unavailable } as unknown as ChannelPort, admission: {} as never, limits };
const roomPort: Pick<ChannelPort, 'send'> = { send: unavailable };
const admission = {
  share: async () => ({ kind: 'ok' as const, value: { inviteRef: 'fixture', shareUrl: 'https://khala.example/c/release', expiresAt: null } }),
};

function presencePort(channel: FixtureChannel): ChannelUiPort {
  const snapshot = { generation: 1, agents: agentPresence(channel) };
  return { agents: async () => snapshot, subscribeAgents: () => () => undefined, installCommand: async () => { throw new Error('unused'); } };
}

function staticTimeline(channel: FixtureChannel): TimelineController {
  const data = timelineData(channel);
  return { getSnapshot: () => data, subscribe: () => () => undefined, loadOlder: async () => null, setReaderAtLatest: () => undefined, dispose: () => undefined };
}

/** Sets a React-controlled textarea's value as typing would. */
function typeInto(textarea: HTMLTextAreaElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

export function ConversationFixture({ search = location.search }: Readonly<{ search?: string }>) {
  const params = useMemo(() => readFixtureParams(search), [search]);
  const channels = useMemo(() => params.empty ? [EMPTY_CHANNEL, ...CHANNELS] : CHANNELS, [params.empty]);
  const [theme, setTheme] = useState<ThemeChoice>(params.theme);
  const [selected, setSelected] = useState(channels[0]!.id);
  const [inThread, setInThread] = useState(params.view === 'thread');
  const [query, setQuery] = useState('');
  const [modes, setModes] = useState(AGENT_MODES);
  const [creating, setCreating] = useState(params.pop === 'new');
  const createButton = useRef<HTMLButtonElement>(null);
  const composer = useRef<TimelineComposerHandle>(null);
  const actions = useRef<{ openParticipant(id: string): void; openInvite: (() => void) | undefined } | null>(null);
  const channel = channels.find(item => item.id === selected)!;
  // The open channel is being read, so its unread count is cleared (the design's "3 unread"). The design
  // creates the empty channel after opening Release, so Release stays read too.
  const summaries = useMemo(() => channels.map(item => ({ ...conversationSummary(item),
    ...(item.id === selected || (params.empty && item.id === CHANNELS[0]!.id) ? { unreadCount: null } : {}) })),
  [channels, selected, params.empty]);
  const controller = useMemo(() => createChannelController(presencePort(channel), { roomId: channel.id as RoomId, generation: 1 }), [channel]);
  const timeline = useMemo(() => staticTimeline(channel), [channel]);
  const pendingStore = useMemo(() => params.failed ? { load: () => failedSends(channel), save: () => undefined } : undefined,
    [channel, params.failed]);
  useEffect(() => () => controller.dispose(), [controller]);

  // Drive the remaining states through the components' own controls, once the presence snapshot has loaded.
  useEffect(() => {
    let cancelled = false;
    const ready = new Promise<void>(resolve => {
      if (controller.getSnapshot().phase === 'ready') { resolve(); return; }
      const unsubscribe = controller.subscribe(() => { if (controller.getSnapshot().phase === 'ready') { unsubscribe(); resolve(); } });
    });
    void ready.then(() => requestAnimationFrame(() => {
      if (cancelled) return;
      const card = document.getElementById('kh-card');
      if (params.draft !== null) {
        const input = card?.querySelector<HTMLTextAreaElement>('#kh-input');
        if (input) typeInto(input, params.draft);
      }
      if (params.chips) card?.querySelector<HTMLButtonElement>('.kh-to-tog')?.click();
      if (params.roster || params.pop === 'add-agent') card?.querySelector<HTMLButtonElement>('#kh-head-btn')?.click();
      if (params.pop === 'add-agent') requestAnimationFrame(() => card?.querySelector<HTMLButtonElement>('.kh-roster [aria-label="Add agent"]')?.click());
      if (params.pop === 'invite') actions.current?.openInvite?.();
      if (params.detail) actions.current?.openParticipant(detailParticipant(params.detail));
      // The design shows the latest messages: start scrolled to the end once fonts and the chips settle.
      void document.fonts.ready.then(() => requestAnimationFrame(() => {
        const thread = card?.querySelector<HTMLElement>('.kh-thread');
        if (thread && !cancelled) thread.scrollTop = thread.scrollHeight;
      }));
    }));
    return () => { cancelled = true; };
  // Only the initial channel is driven; later navigation is the reader's.
  }, []);

  return <HueOverrideProvider hues={HUE_OVERRIDES}>
    <KhalaApp theme={theme} onThemeChange={setTheme} inThread={inThread}
      list={<ConversationList conversations={summaries} selectedId={selected} query={query} onQueryChange={setQuery} status="ready"
        timeOptions={FIXTURE_TIME} viewerOwnerId={VIEWER.ownerId}
        onSelect={id => { setSelected(id); setInThread(true); }}
        action={<>
          <button ref={createButton} type="button" className="kh-ib sm" data-tip="New channel" aria-label="New channel" aria-expanded={creating}
            onClick={() => setCreating(open => !open)}><PlusIcon /></button>
          <NewChannelPopover anchor={createButton} open={creating} onClose={() => setCreating(false)} ports={newChannelPorts} onOpenRoom={() => undefined} />
        </>} />}
      main={<ChannelScreen key={channel.id} title={channel.title} controller={controller} timeOptions={FIXTURE_TIME}
        viewerOwnerId={VIEWER.ownerId} viewerName={VIEWER.displayName} viewerParticipantId={VIEWER.participantId} viewerColor={HUMANS.me.color}
        humanParticipants={humanParticipants(channel)} describeParticipant={describeParticipant}
        modeFor={participantId => modes[participantId] ?? 'sync'}
        onSetMode={async (participantId, mode) => {
          setTimeout(() => setModes(current => ({ ...current, [participantId]: mode })), 300);
          return 'sent';
        }}
        recentActivity={(participantId, render) => timelineData(channel).items
          .flatMap(item => item.content.kind === 'text' && item.ref.authorParticipantId === participantId
            ? [{ id: item.ref.eventId, at: item.receivedAt, body: renderMessageContent(item.content, render) }] : [])
          .slice(-3).reverse()}
        onMention={label => composer.current?.insertMention(label)}
        onRosterOpen={() => composer.current?.closeChips()}
        onBack={() => setInThread(false)}
        renderShare={() => <ChannelInvite admission={admission} roomId={channel.id as RoomId} />}
        renderAddAgent={() => <ChannelAddAgent admission={admission} roomId={channel.id as RoomId} />}
        renderTimeline={(openParticipant, openInvite, onMentionRoster) => {
          actions.current = { openParticipant, openInvite };
          return <TimelineScreen key={`${channel.id}:${params.failed}`} controller={timeline} roomPort={roomPort} roomId={channel.id as RoomId}
            viewer={VIEWER} members={channelMembers(channel)} composerRef={composer} describeParticipant={describeParticipant} onOpenParticipant={openParticipant} onMentionRoster={onMentionRoster}
            {...(openInvite ? { onInvite: openInvite } : {})} {...(pendingStore ? { pendingStore } : {})}
            now={() => FIXTURE_NOW} timeOptions={FIXTURE_TIME} />;
        }} />} />
  </HueOverrideProvider>;
}
