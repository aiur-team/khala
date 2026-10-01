import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createChannelController } from '../../features/channel/controller';
import type { ChannelUiPort } from '../../features/channel/ports';
import { ChannelScreen } from '../../features/channel/ChannelScreen';
import { createTimelineController } from '../../features/timeline/controller';
import { TimelineScreen } from '../../features/timeline/TimelineScreen';
import { projectTimelineNames } from '../../features/timeline/names';
import { validateAgentName } from '@khala/contracts/messaging/agent-names';
import type { ParticipantView } from '@khala/contracts/messaging/index';
import { Panel } from '../../shell/Panel';
import { KhalaPageFrame } from '../../shell/KhalaPageFrame';
import { ClosureAction } from '../../features/recovery/RecoveryPanel';
import { createRecoveryController } from '../../features/recovery/controller';
import { ConversationSettingsDisclosure } from './ConversationSettingsDisclosure';
import { createBrowserRecoveryPort, sessionResumeStore } from '../recovery/browser-port';
import type { HumanRoomRenderer } from './mount';
import type { ReviewCapability } from '../review/register';
import { createReviewController, type ReviewController } from '../../features/review/controller';
import { ReviewScreen } from '../../features/review/ReviewScreen';
import type { OwnerReviewBinding } from '../review/owner-mailbox-client';
import { createOwnerMailboxReviewClient } from '../review/owner-mailbox-client';
import type { ControlsCapability } from '../controls/register';
import { AgentControlsPanel, AgentListeningControls, UnavailableListeningModes } from '../../features/agent-controls/AgentControlsPanel';
import { ChannelSharePanel } from '../../features/channel/ChannelSharePanel';
import type { AgentControlsPorts } from '../../features/agent-controls/ports';
import { useConversationIndex } from './ConversationIndexRoute';
import type { HumanRouteCodec } from './routes';
import { createHumanPendingSendStore } from './pending-send-store';

type ReviewClient = ReturnType<typeof createOwnerMailboxReviewClient>;
type ReviewRoomId = Parameters<HumanRoomRenderer>[1]['roomId'];
type TrustBinding = (context: Parameters<HumanRoomRenderer>[0], roomId: ReviewRoomId,
  binding: OwnerReviewBinding, signal: AbortSignal) => Promise<boolean>;

function reviewIdentity(context: Parameters<HumanRoomRenderer>[0], roomId: ReviewRoomId,
  binding: OwnerReviewBinding): string {
  return JSON.stringify([context.principal.ownerId, context.generation, roomId,
    binding.bindingId, binding.generation, binding.agentParticipantId, binding.device]);
}
function reviewScope(context: Parameters<HumanRoomRenderer>[0], roomId: ReviewRoomId): string {
  return JSON.stringify([context.principal.ownerId, context.generation, roomId]);
}

function hostedPresence(context: Parameters<HumanRoomRenderer>[0], onParticipants: (participants: readonly ParticipantView[]) => void): ChannelUiPort {
  let readEpoch = 0;
  const agents: ChannelUiPort['agents'] = async (roomId, signal) => {
    const epoch = ++readEpoch;
    const participants = await context.roomParticipants?.(roomId, signal);
    if (!participants) throw new Error('agent roster unavailable');
    if (!signal.aborted && epoch === readEpoch) onParticipants(participants);
    return { generation: context.generation, agents: participants.filter(item => item.kind === 'agent').map(item => ({
      participantId: item.participantId, ownerId: item.ownerId, displayName: item.displayName,
      ownerDisplayName: participants.find(owner => owner.kind === 'human' && owner.ownerId === item.ownerId)?.displayName ?? 'Channel member',
      connection: 'unknown' as const, routeLabel: 'Channel agent', lastReceipt: null, acknowledgement: 'unknown' as const,
    })) };
  };
  return {
    agents,
    subscribeAgents(roomId, listener) {
      let epoch = 0;
      let request: AbortController | null = null;
      const timer = setInterval(() => {
        request?.abort();
        request = new AbortController();
        const current = ++epoch;
        void agents(roomId, request.signal).then(snapshot => {
          if (current === epoch && !request?.signal.aborted) listener(snapshot);
        }).catch(() => {});
      }, 5_000);
      return () => { ++epoch; request?.abort(); clearInterval(timer); };
    },
    async installCommand() { throw new Error('agent onboarding unavailable'); },
  };
}

export const renderHumanRoom: HumanRoomRenderer = (context, route, navigate, routes) => (
  <HumanRoom key={`${context.principal.ownerId}:${context.generation}:${route.roomId}`} context={context} roomId={route.roomId}
    {...(navigate && routes ? { navigate, routes } : {})} />
);

/** Production room renderer with the authenticated owner mailbox attached. */
export function createHumanRoomRenderer(review: ReviewClient, capability: ReviewCapability,
  trustBinding: TrustBinding, refreshMs = 5_000,
  controls?: ControlsCapability): HumanRoomRenderer & { tools: HumanRoomRenderer } {
  const render = (toolsOnly: boolean): HumanRoomRenderer => (context, route, navigate, routes) => <HumanRoom key={`${context.principal.ownerId}:${context.generation}:${route.roomId}`} context={context} roomId={route.roomId}
    {...(navigate && routes ? { navigate, routes } : {})} review={review}
    capability={capability} trustBinding={trustBinding} refreshMs={refreshMs}
    {...(controls ? { controls } : {})} toolsOnly={toolsOnly} />;
  return Object.assign(render(false), { tools: render(true) });
}

function ControlsForBinding({ context, roomId, capability, binding, compact = false, agentLabel }: {
  context: Parameters<HumanRoomRenderer>[0];
  roomId: ReviewRoomId;
  capability: ControlsCapability;
  binding: OwnerReviewBinding;
  compact?: boolean;
  agentLabel?: string;
}) {
  const [ports, setPorts] = useState<AgentControlsPorts | null>(null);
  const identity = JSON.stringify([context.principal.ownerId, context.generation, roomId,
    binding.bindingId, binding.generation, binding.agentParticipantId]);
  useEffect(() => {
    // HumanScreen attaches the route capability in its passive effect.
    const timer = setTimeout(() => {
      const port = capability.portFor(context, roomId, binding);
      if (port) setPorts({ agentControls: port });
    }, 0);
    return () => { clearTimeout(timer); };
  }, [identity, capability, context, roomId]);
  if (!ports) return compact ? <p role="status">Checking this agent’s listening modes…</p>
    : <Panel heading="Agent controls"><p role="status">Loading controls…</p></Panel>;
  const config = {
    bindingId: binding.bindingId, roomId, peerParticipantId: binding.agentParticipantId as never,
    viewerOwnerId: context.principal.ownerId, agentLabel: agentLabel ?? binding.agentParticipantId, roomLabel: roomId,
  };
  return compact ? <AgentListeningControls ports={ports} config={config} /> : <AgentControlsPanel ports={ports} config={config} />;
}

export function HumanControls({ context, roomId, review, capability, refreshMs }: {
  context: Parameters<HumanRoomRenderer>[0];
  roomId: ReviewRoomId;
  review: ReviewClient | undefined;
  capability: ControlsCapability | undefined;
  refreshMs: number;
}) {
  const scope = reviewScope(context, roomId);
  const [discovery, setDiscovery] = useState<Readonly<{ scope: string; bindings: readonly OwnerReviewBinding[] }> | null>(null);
  useEffect(() => {
    if (!review || !capability || capability.state !== 'ready') return;
    const abort = new AbortController();
    let epoch = 0;
    setDiscovery(null);
    const refresh = () => {
      const current = ++epoch;
      void review.bindings(roomId, abort.signal).then(bindings => {
        if (!abort.signal.aborted && current === epoch) {
          setDiscovery(bindings === null ? null : { scope, bindings });
        }
      }).catch(() => { if (!abort.signal.aborted && current === epoch) setDiscovery(null); });
    };
    refresh();
    const timer = setInterval(refresh, refreshMs);
    return () => { abort.abort(); clearInterval(timer); };
  }, [context, roomId, review, capability, refreshMs, scope]);
  if (!capability || capability.state !== 'ready' || !review || discovery?.scope !== scope) {
    return <Panel heading="Agent controls"><p role="status">Agent controls are unavailable or loading.</p></Panel>;
  }
  if (discovery.bindings.length === 0) {
    return <Panel heading="Agent controls"><p role="status">No active agent connection in this channel.</p></Panel>;
  }
  return <>{discovery.bindings.map(binding => <ControlsForBinding
    key={JSON.stringify([scope, binding.bindingId, binding.generation, binding.agentParticipantId])}
    context={context} roomId={roomId} capability={capability} binding={binding} />)}</>;
}

function ReviewForBinding({ context, roomId, capability, binding }: {
  context: Parameters<HumanRoomRenderer>[0];
  roomId: Parameters<HumanRoomRenderer>[1]['roomId'];
  capability: ReviewCapability;
  binding: OwnerReviewBinding;
}) {
  const [controller, setController] = useState<ReviewController | null>(null);
  const identity = reviewIdentity(context, roomId, binding);
  useEffect(() => {
    // The route shell attaches the shared capability in its passive effect.
    // Run after that effect so its route lease owns this port and teardown.
    let active: ReviewController | null = null;
    const timer = setTimeout(() => {
      const port = capability.portFor(context, roomId, binding);
      if (port) {
        active = createReviewController(port);
        setController(active);
      }
    }, 0);
    return () => { clearTimeout(timer); active?.dispose(); };
  }, [identity, capability, context, roomId]);
  return controller ? <ReviewScreen controller={controller} recipientLabel={binding.agentParticipantId}
    renderContent={content => <span dir="auto">{content.body}</span>} /> : <Panel heading="Recipient review"><p role="status">Loading review…</p></Panel>;
}

function useOwnerBindingTrust(context: Parameters<HumanRoomRenderer>[0], roomId: ReviewRoomId,
  review: ReviewClient | undefined, trustBinding: TrustBinding | undefined, refreshMs: number) {
  const [discovery, setDiscovery] = useState<Readonly<{ scope: string; active: number;
    bindings: readonly OwnerReviewBinding[] }> | null>(null);
  const scope = reviewScope(context, roomId);
  useEffect(() => {
    if (!review || !trustBinding) return;
    const abort = new AbortController();
    const trusted = new Set<string>();
    const trusting = new Map<string, Promise<boolean>>();
    let refreshEpoch = 0;
    let latest: { epoch: number; value: readonly OwnerReviewBinding[]; identities: Set<string> } | null = null;
    setDiscovery(null);
    const publish = () => {
      if (!latest || abort.signal.aborted || latest.epoch !== refreshEpoch) return;
      setDiscovery({ scope, active: latest.value.length, bindings: latest.value.filter(binding =>
        binding.device !== null && trusted.has(reviewIdentity(context, roomId, binding))) });
    };
    const refresh = () => {
      const epoch = ++refreshEpoch;
      const current = () => !abort.signal.aborted && epoch === refreshEpoch;
      void review.bindings(roomId, abort.signal).then(value => {
        if (!current()) return;
        if (value === null) { latest = null; trusted.clear(); setDiscovery(null); return; }
        const identities = new Set(value.filter(binding => binding.device)
          .map(binding => reviewIdentity(context, roomId, binding)));
        latest = { epoch, value, identities };
        for (const key of trusted) if (!identities.has(key)) trusted.delete(key);
        for (const key of trusting.keys()) if (!identities.has(key)) trusting.delete(key);
        publish();
        for (const binding of value) {
          if (!binding.device) continue;
          const key = reviewIdentity(context, roomId, binding);
          if (trusted.has(key)) continue;
          let pending = trusting.get(key);
          if (!pending) {
            pending = Promise.resolve().then(() => abort.signal.aborted ? false
              : trustBinding(context, roomId, binding, abort.signal)).catch(() => false);
            trusting.set(key, pending);
            void pending.then(() => { if (trusting.get(key) === pending) trusting.delete(key); });
          }
          void pending.then(established => {
            if (abort.signal.aborted || !latest?.identities.has(key)) return;
            if (established) { trusted.add(key); publish(); }
          });
        }
      }).catch(() => { if (current()) { latest = null; trusted.clear(); setDiscovery(null); } });
    };
    refresh();
    const timer = setInterval(refresh, refreshMs);
    return () => { abort.abort(); clearInterval(timer); };
  }, [context, roomId, review, trustBinding, refreshMs, scope]);
  return discovery?.scope === scope ? discovery : null;
}

export function HumanReview({ context, roomId, review, capability, trustBinding, refreshMs }: {
  context: Parameters<HumanRoomRenderer>[0];
  roomId: Parameters<HumanRoomRenderer>[1]['roomId'];
  review: ReviewClient | undefined;
  capability: ReviewCapability | undefined;
  trustBinding: TrustBinding | undefined;
  refreshMs: number;
}) {
  const discovery = useOwnerBindingTrust(context, roomId, review, trustBinding, refreshMs);
  if (!review || !capability || !trustBinding || discovery === null) {
    return <Panel heading="Recipient review"><p role="status">Review unavailable or loading.</p></Panel>;
  }
  if (discovery.active === 0) return <Panel heading="Recipient review"><p role="status">No active agent recipient in this channel.</p></Panel>;
  if (discovery.bindings.length === 0) return <Panel heading="Recipient review"><p role="status">Waiting for verified agent device trust.</p></Panel>;
  return <>{discovery.bindings.map(binding => <ReviewForBinding key={reviewIdentity(context, roomId, binding)} context={context} roomId={roomId}
    capability={capability} binding={binding} />)}</>;
}

function HumanRoom({ context, roomId, navigate, routes, review, capability, trustBinding, refreshMs = 5_000, controls, toolsOnly = false }: {
  context: Parameters<HumanRoomRenderer>[0];
  roomId: Parameters<HumanRoomRenderer>[1]['roomId'];
  navigate?: (path: string) => void;
  routes?: HumanRouteCodec;
  review?: ReviewClient;
  capability?: ReviewCapability;
  controls?: ControlsCapability;
  trustBinding?: TrustBinding;
  refreshMs?: number;
  toolsOnly?: boolean;
}) {
  const conversations = useConversationIndex(context);
  const selectedConversation = conversations?.find(item => item.id === roomId);
  const timeline = useMemo(
    () => createTimelineController(context.room, roomId, { generation: context.generation, pageSize: 50 }),
    [context.generation, context.room, roomId],
  );
  const deviceId = context.device.current().deviceId;
  const pendingStore = useMemo(() => deviceId === null ? undefined
    : createHumanPendingSendStore(context.principal.ownerId, deviceId, roomId),
  [context.principal.ownerId, deviceId, roomId]);
  const participantScope = reviewScope(context, roomId);
  const [participantRoster, setParticipantRoster] = useState<Readonly<{
    scope: string; participants: readonly ParticipantView[];
  }> | null>(null);
  const room = useMemo(
    () => createChannelController(hostedPresence(context, participants => setParticipantRoster({ scope: participantScope, participants })),
      { roomId, generation: context.generation }),
    [context, roomId, participantScope],
  );
  const recovery = useMemo(() => createBrowserRecoveryPort({
    principal: context.principal, identity: context.identity, device: context.device,
    ...(context.room.observeEntries ? { historyEntries: { roomId, observeEntries: context.room.observeEntries } } : {}),
    resumeStore: sessionResumeStore(context.principal.ownerId, roomId),
    ...(context.closure ? { closure: context.closure(roomId) } : {}),
    ...(context.revocation ? { revocation: context.revocation(roomId) } : {}),
  }), [context, roomId]);
  const [recoveryOwner, setRecoveryOwner] = useState<{
    ports: typeof recovery; roomId: ReviewRoomId; controller: ReturnType<typeof createRecoveryController>;
  } | null>(null);
  useEffect(() => {
    const controller = createRecoveryController(recovery, { roomId, roomRevision: 0 });
    setRecoveryOwner({ ports: recovery, roomId, controller });
    return () => controller.dispose();
  }, [recovery, roomId]);
  const recoveryController = recoveryOwner?.ports === recovery && recoveryOwner.roomId === roomId
    ? recoveryOwner.controller : null;
  useEffect(() => () => {
    timeline.dispose();
    room.dispose();
    recovery.dispose();
  }, [room, timeline, recovery]);
  const viewer = context.participant?.() ?? null;
  const timelineData = useSyncExternalStore(timeline.subscribe, timeline.getSnapshot, timeline.getSnapshot);
  const presence = useSyncExternalStore(room.subscribe, room.getSnapshot, room.getSnapshot);
  const extraParticipants = presence.agents.flatMap(agent => agent.ownerId ? [{
    participantId: agent.participantId, ownerId: agent.ownerId, kind: 'agent' as const,
    initialName: agent.displayName,
  }] : []);
  const currentNames = viewer ? projectTimelineNames(timelineData.nameHistory ?? timelineData.items, viewer, extraParticipants).currentNames : undefined;
  const roomAccessible = viewer !== null && (!context.conversations || conversations?.some(item => item.id === roomId));
  const trustedBindings = useOwnerBindingTrust(context, roomId, roomAccessible && !toolsOnly ? review : undefined,
    roomAccessible && !toolsOnly ? trustBinding : undefined, refreshMs);
  const toolsRoot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!toolsOnly) return;
    const heading = toolsRoot.current?.querySelector('h1');
    if (heading) { heading.tabIndex = -1; heading.focus(); }
  }, [roomId, toolsOnly]);
  if (context.conversations && conversations === undefined) {
    return <Panel heading="Loading conversation"><p role="status">Checking channel access…</p></Panel>;
  }
  if (context.conversations && conversations === null) {
    return <Panel heading="Conversation unavailable"><p role="alert">Channel access could not be checked. Try reloading.</p></Panel>;
  }
  if (context.conversations && conversations && !conversations.some(item => item.id === roomId)) {
    return <Panel heading="Conversation unavailable"><p role="alert">You no longer have access to this encrypted conversation.</p></Panel>;
  }
  if (viewer === null) {
    return (
      <Panel heading="Conversation unavailable">
        <p role="alert">Participant attribution is unavailable for this session.</p>
      </Panel>
    );
  }

  if (toolsOnly) {
    return <div ref={toolsRoot} className="channel-tools-page"><KhalaPageFrame model={{ title: 'Recipient review', labelledBy: 'khala-recipient-review-title' }}>
      {routes ? <a href={routes.roomPath(roomId)} onClick={navigate ? event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); navigate(routes.roomPath(roomId));
      } : undefined}>Back to conversation</a> : null}
      <HumanReview context={context} roomId={roomId} review={review} capability={capability}
        trustBinding={trustBinding} refreshMs={refreshMs} />
      <HumanControls context={context} roomId={roomId} review={review} capability={controls} refreshMs={refreshMs} />
    </KhalaPageFrame></div>;
  }

  return (
    <ChannelScreen
      embedded={Boolean(context.conversations && routes && navigate)}
      title={selectedConversation?.title ?? 'Encrypted conversation'}
      controller={room}
      viewerOwnerId={viewer.ownerId}
      viewerName={viewer.displayName}
      {...(participantRoster?.scope === participantScope ? { humanParticipants: participantRoster.participants
        .filter(participant => participant.kind === 'human' && participant.participantId !== viewer.participantId) } : {})}
      renameScope={roomId}
      namesPending={timelineData.namesReady === false}
      {...(currentNames ? { currentNames } : {})}
      renderOwnerControls={agent => {
        if (viewer.kind !== 'human' || agent.ownerId !== viewer.ownerId) return null;
        if (!controls || controls.state !== 'ready' || !review || !trustBinding) {
          return <div className="agent-controls__compact"><UnavailableListeningModes reason="Mode controls are not ready. Try again later." /></div>;
        }
        if (trustedBindings === null) return <div className="agent-controls__compact"><UnavailableListeningModes reason="Checking this agent’s session…" /></div>;
        const bindings = trustedBindings.bindings.filter(binding => binding.agentParticipantId === agent.participantId);
        if (bindings.length === 0) return <div className="agent-controls__compact"><UnavailableListeningModes reason="Verify this agent’s session to choose a listening mode." /></div>;
        return bindings.map(binding => <ControlsForBinding
          key={reviewIdentity(context, roomId, binding)} context={context} roomId={roomId}
          capability={controls} binding={binding} compact agentLabel={agent.displayName} />);
      }}
      renameAgent={async (participantId, name, clientTxnId) => {
        const checked = validateAgentName(name);
        const target = room.getSnapshot().agents.find(agent => agent.participantId === participantId);
        if (!checked.ok || checked.name !== name || viewer.kind !== 'human'
          || target?.ownerId !== viewer.ownerId || timeline.getSnapshot().membership !== 'joined') return 'rejected';
        const result = await context.room.send({ roomId, clientTxnId,
          content: { v: 1, kind: 'agent_rename', agentParticipantId: participantId, body: name } });
        if (result.kind === 'rejected') return 'rejected';
        return result.kind === 'ok' && result.value.state === 'accepted' ? 'accepted' : 'unknown';
      }}
      renderShare={() => context.admission ? <ChannelSharePanel key={`${context.principal.ownerId}:${context.generation}:${roomId}`}
        admission={context.admission} roomId={roomId}
        {...(context.channelLinks ? { channelLinks: context.channelLinks } : {})} /> : null}
      renderHeaderActions={() => <ConversationSettingsDisclosure scope={participantScope}
        recovery={{ ports: recovery, controller: recoveryController, config: { roomId, roomRevision: 0 },
          onClosureParticipationEnded: () => navigate && routes ? navigate(routes.conversationsPath()) : globalThis.location?.assign('/') }} />}
      renderDetailsActions={open => <ClosureAction ports={recovery} controller={recoveryController}
        config={{ roomId, roomRevision: 0 }} disclosureOpen={open}
        onClosureParticipationEnded={() => navigate && routes ? navigate(routes.conversationsPath()) : globalThis.location?.assign('/')} />}
      renderTimeline={() => (
        <TimelineScreen key={JSON.stringify([context.principal.ownerId, deviceId, context.generation, roomId])}
          controller={timeline} roomPort={context.room} roomId={roomId} viewer={viewer}
          extraParticipants={extraParticipants}
          {...(pendingStore ? { pendingStore } : {})}
          unreadableActivity={selectedConversation?.preview === null && selectedConversation.timestamp !== null} />
      )}
    />
  );
}
