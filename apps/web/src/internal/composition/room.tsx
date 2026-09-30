import { useEffect, useMemo, useRef, useSyncExternalStore, type Ref } from 'react';
import type { RoomId } from '@khala/contracts/messaging/index';
import type { LocalTransport, LocalTransportState } from '@khala/messaging/local/http/index';
import { createChannelController } from '../../features/channel/controller';
import { type ReceiptEvidencePort, createReceiptEvidenceController } from '../../features/receipt-evidence/controller';
import type { ChannelUiPort } from '../../features/channel/ports';
import { ChannelScreen } from '../../features/channel/ChannelScreen';
import { createTimelineController } from '../../features/timeline/controller';
import { TimelineScreen } from '../../features/timeline/TimelineScreen';
import { projectTimelineNames } from '../../features/timeline/names';
import { validateAgentName } from '@khala/contracts/messaging/agent-names';
import { Panel } from '../../shell/Panel';
import { LocalToolsIcon } from '../../shell/icons';
import type { HumanRouteContext } from '../../composition/human/application';
import { LocalAgentControls } from '../controls/LocalAgentControls';
import { createListeningController } from '../controls/listening-controller';
import type { ListeningPort } from '../controls/listening-port';
import { StopControl } from '../controls/StopControl';
import { createStopController } from '../controls/stop-controller';
import type { BindingStopPort } from '../controls/stop-port';
import { MakeExternalEntry, linkedSendReason, useJourneySummary } from '../make-external/ChannelEntry';
import type { MakeExternalPort } from '../make-external/port';
import { createPendingSendStore } from './pending-store';
import { useConversationIndex } from '../../composition/human/ConversationIndexRoute';

/** The binding Stop control's port and the channel URL a replacement agent joins with. */
export type LocalStopCapability = Readonly<{
  port: BindingStopPort;
  channelUrl(roomId: string): string;
}>;

// Agent presence and listening mode belong to their own tickets; they arrive
// here as injected capabilities, never as UI built by this entry.
const unavailablePresence: ChannelUiPort = {
  async agents() { throw new Error('agent presence unavailable'); },
  subscribeAgents: () => () => undefined,
  async installCommand() { throw new Error('agent onboarding unavailable'); },
};

/** Exactly what the launcher prints: channel arguments only need quoting for a leading `~`. */
export function resumeCommand(roomId: string): string {
  return `khala internal --resume ${roomId.startsWith('~') ? `'${roomId}'` : roomId}`;
}

/** Why the composer is paused in a transport state, or `null` when it may send. */
export function sendBlockedReason(state: LocalTransportState): string | null {
  switch (state.kind) {
    case 'live':
      return null;
    case 'connecting':
      return 'Sending starts once Khala connects to the local server.';
    case 'reconnecting':
      return 'Sending is paused while Khala reconnects. Your draft is kept.';
    case 'stopped':
      return 'Sending is paused because the local server is not reachable. Your draft is kept.';
    case 'channel_unavailable':
      return 'Sending is unavailable because this session can no longer open this channel.';
    case 'auth_failed':
      return 'Sending is unavailable because this local session has ended.';
  }
}

export function TransportStatus({ state, roomId, onRetry }: {
  state: LocalTransportState;
  roomId: string;
  onRetry: () => void;
}) {
  const terminal = useRef<HTMLHeadingElement | null>(null);

  // A state that needs the reader's action takes focus so it is never missed.
  useEffect(() => {
    if (state.kind === 'stopped' || state.kind === 'channel_unavailable' || state.kind === 'auth_failed') terminal.current?.focus();
  }, [state.kind]);

  let message: string;
  switch (state.kind) {
    case 'connecting':
      message = 'Connecting to the local Khala server…';
      break;
    case 'live':
      message = '';
      break;
    case 'reconnecting':
      message = `Lost the connection to the local Khala server. Reconnecting (attempt ${state.attempt})…`;
      break;
    default:
      message = '';
  }

  return (
    <div className="local-transport">
      <p className="local-transport__status" role="status" aria-live="polite">{message}</p>
      {state.kind === 'stopped' ? (
        <div className="local-transport__terminal" role="alert">
          <h2 ref={terminal} tabIndex={-1}>The local Khala server stopped</h2>
          <p>
            Channel <code>{roomId}</code> is still saved on this computer. Resume it with:
          </p>
          <pre><code>{resumeCommand(roomId)}</code></pre>
          <button type="button" onClick={onRetry}>Try to reconnect</button>
        </div>
      ) : null}
      {state.kind === 'channel_unavailable' ? (
        <div className="local-transport__terminal" role="alert">
          <h2 ref={terminal} tabIndex={-1}>This channel is not available</h2>
          <p>
            The local server is running, but this session can no longer open channel <code>{roomId}</code>.
          </p>
        </div>
      ) : null}
      {state.kind === 'auth_failed' ? <SessionEnded roomId={roomId} headingRef={terminal} /> : null}
    </div>
  );
}

export function SessionEnded({ roomId, headingRef }: {
  roomId: string | null;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <div className="local-transport__terminal" role="alert">
      <h2 ref={headingRef} tabIndex={-1}>This local session has ended</h2>
      <p>The link that opened this page has expired or was replaced. Relaunch Khala from your terminal to get a new one.</p>
      {roomId === null ? null : <pre><code>{resumeCommand(roomId)}</code></pre>}
    </div>
  );
}

/** Receipt projections do not raise channel hints, so evidence is also reread on this interval. */
export const EVIDENCE_POLL_MS = 5_000;

export function LocalRoom({
  context, roomId, transport, evidencePort, evidencePollMs = EVIDENCE_POLL_MS, stop, listening, makeExternal = null,
  onMakeExternal = () => undefined,
  settingsHref,
}: {
  context: HumanRouteContext;
  roomId: RoomId;
  transport: LocalTransport;
  evidencePort?: ReceiptEvidencePort;
  evidencePollMs?: number;
  stop?: LocalStopCapability;
  /** Owner listening-mode and pause control; absent means the page shows none. */
  listening?: ListeningPort;
  /** The Make-external journey port; without it the page offers no such action. */
  makeExternal?: MakeExternalPort | null;
  onMakeExternal?: () => void;
  settingsHref?: string;
}) {
  const journey = useJourneySummary(makeExternal, roomId);
  const conversations = useConversationIndex(context);
  const title = conversations?.find(item => item.id === roomId)?.title ?? 'Channel';
  const evidence = useMemo(
    () => (evidencePort ? createReceiptEvidenceController(evidencePort, roomId) : undefined),
    [evidencePort, roomId],
  );
  const state = useSyncExternalStore(transport.subscribe, transport.current, transport.current);
  const timeline = useMemo(
    () => createTimelineController(context.room, roomId, { generation: context.generation, pageSize: 50 }),
    [context.generation, context.room, roomId],
  );
  const localPresence = useMemo<ChannelUiPort>(() => transport.participants ? ({
    async agents(channelId, signal) {
      const result = await transport.participants!(channelId, signal);
      if (result.kind !== 'done') throw new Error('agent_presence_unavailable');
      return { generation: context.generation, agents: result.value.filter(person => person.kind === 'agent').map(person => ({
        participantId: person.participantId, ownerId: person.ownerId, displayName: person.displayName,
        ownerDisplayName: person.ownerId, connection: 'connected' as const, routeLabel: 'Local agent',
        lastReceipt: null, acknowledgement: 'unknown' as const,
      })) };
    },
    subscribeAgents(channelId, listener) {
      const abort = new AbortController();
      const refresh = () => { void this.agents(channelId, abort.signal).then(listener).catch(() => undefined); };
      const timer = setInterval(refresh, 5_000);
      return () => { abort.abort(); clearInterval(timer); };
    },
    async installCommand() { throw new Error('local_agent_is_joined'); },
  }) : unavailablePresence, [context.generation, transport]);
  useEffect(() => {
    if (!evidence) return undefined;
    const timer = setInterval(() => { if (timeline.getSnapshot().items.length > 0) void evidence.refresh(); }, evidencePollMs);
    return () => {
      clearInterval(timer);
      evidence.dispose();
    };
  }, [evidence, evidencePollMs, timeline]);
  const channel = useMemo(
    () => createChannelController(localPresence, { roomId, generation: context.generation }),
    [context.generation, localPresence, roomId],
  );
  const stopController = useMemo(() => (stop ? createStopController(stop.port, roomId) : null), [stop, roomId]);
  useEffect(() => () => stopController?.dispose(), [stopController]);
  const listeningController = useMemo(() => (listening ? createListeningController(listening, roomId) : null), [listening, roomId]);
  // An agent can change its own mode, and Stop removes agents, so the owner's view is reread on the evidence interval.
  useEffect(() => {
    if (!listeningController) return undefined;
    void listeningController.refresh();
    const timer = setInterval(() => void listeningController.refresh(), evidencePollMs);
    return () => {
      clearInterval(timer);
      listeningController.dispose();
    };
  }, [evidencePollMs, listeningController]);
  const pendingStore = useMemo(() => createPendingSendStore(context.principal.ownerId, roomId), [context.principal.ownerId, roomId]);
  useEffect(() => () => {
    timeline.dispose();
    channel.dispose();
  }, [channel, timeline]);
  // A failed history read is reread once the transport is live, whichever
  // happened last. Keyed on both values, so a read that keeps failing retries
  // only on the next transport or phase change, never in a tight loop.
  const phase = useSyncExternalStore(timeline.subscribe, () => timeline.getSnapshot().phase, () => timeline.getSnapshot().phase);
  useEffect(() => {
    if (state.kind === 'live' && (phase === 'unavailable' || phase === 'partial')) void timeline.loadOlder();
  }, [phase, state.kind, timeline]);
  // New or older rows may carry evidence already projected: reread with them.
  const timelineData = useSyncExternalStore(timeline.subscribe, timeline.getSnapshot, timeline.getSnapshot);
  const items = timelineData.items;
  const presence = useSyncExternalStore(channel.subscribe, channel.getSnapshot, channel.getSnapshot);
  useEffect(() => {
    if (items.length > 0) void evidence?.refresh();
  }, [evidence, items]);
  const viewer = context.participant?.() ?? null;
  if (viewer === null) {
    return (
      <Panel heading="Channel unavailable">
        <p role="alert">Participant attribution is unavailable for this session.</p>
      </Panel>
    );
  }
  const extraParticipants = presence.agents.flatMap(agent => agent.ownerId ? [{
    participantId: agent.participantId, ownerId: agent.ownerId, kind: 'agent' as const,
    initialName: agent.displayName,
  }] : []);
  const currentNames = projectTimelineNames(timelineData.nameHistory ?? items, viewer, extraParticipants).currentNames;

  return (
    <ChannelScreen
      embedded
      title={title}
      description="Local · Plaintext on this device"
      controller={channel}
      viewerOwnerId={viewer.ownerId}
      viewerName={viewer.displayName}
      renameScope={roomId}
      namesPending={timelineData.namesReady === false}
      currentNames={currentNames}
      renameAgent={async (participantId, name, clientTxnId) => {
        const checked = validateAgentName(name);
        const target = channel.getSnapshot().agents.find(agent => agent.participantId === participantId);
        if (!checked.ok || checked.name !== name || viewer.kind !== 'human'
          || target?.ownerId !== viewer.ownerId || state.kind !== 'live') return 'rejected';
        const result = await context.room.send({ roomId, clientTxnId,
          content: { v: 1, kind: 'agent_rename', agentParticipantId: participantId, body: name } });
        if (result.kind === 'rejected') return 'rejected';
        return result.kind === 'ok' && result.value.state === 'accepted' ? 'accepted' : 'unknown';
      }}
      showPresence={false}
      renderHeaderActions={() => <>
        {listeningController ? <LocalAgentControls controller={listeningController} /> : null}
        <details className="local-channel-tools"><summary className="aiur-shell__icon-button" aria-label="Local tools" title="Local tools"><LocalToolsIcon /></summary><div className="local-channel-tools__content">
          {settingsHref ? <a href={settingsHref}>Channel discovery settings</a> : null}
          {stop && stopController ? <details><summary>Stop agent delivery</summary><StopControl controller={stopController} replacementAccessUrl={stop.channelUrl(roomId)} /></details> : null}
          {makeExternal ? journey.kind === 'unknown' ? <p role="status">Checking conversion options…</p>
            : journey.kind === 'absent' ? <p role="status">Conversion options are unavailable.</p>
              : <MakeExternalEntry summary={journey} onOpen={onMakeExternal} /> : null}
        </div></details>
      </>}
      renderTimeline={() => (
        <>
          <TransportStatus state={state} roomId={roomId} onRetry={() => transport.retry()} />
          <TimelineScreen
            controller={timeline}
            roomPort={context.room}
            roomId={roomId}
            viewer={viewer}
            extraParticipants={extraParticipants}
            sendBlockedReason={linkedSendReason(journey) ?? sendBlockedReason(state)}
            pendingStore={pendingStore}
            {...(evidence ? { evidence } : {})}
          />
        </>
      )}
    />
  );
}
