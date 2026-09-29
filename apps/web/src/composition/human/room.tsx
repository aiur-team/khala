import { useEffect, useMemo, useState } from 'react';
import { createChannelController } from '../../features/channel/controller';
import type { ChannelUiPort } from '../../features/channel/ports';
import { ChannelScreen } from '../../features/channel/ChannelScreen';
import { createTimelineController } from '../../features/timeline/controller';
import { TimelineScreen } from '../../features/timeline/TimelineScreen';
import { Panel } from '../../shell/Panel';
import { RecoveryPanel } from '../../features/recovery/RecoveryPanel';
import { createBrowserRecoveryPort, sessionResumeStore } from '../recovery/browser-port';
import type { HumanRoomRenderer } from './mount';
import type { ReviewCapability } from '../review/register';
import { createReviewController, type ReviewController } from '../../features/review/controller';
import { ReviewScreen } from '../../features/review/ReviewScreen';
import type { OwnerReviewBinding } from '../review/owner-mailbox-client';
import { createOwnerMailboxReviewClient } from '../review/owner-mailbox-client';
import type { ControlsCapability } from '../controls/register';
import { AgentControlsPanel } from '../../features/agent-controls/AgentControlsPanel';
import { ChannelSharePanel } from '../../features/channel/ChannelSharePanel';
import type { AgentControlsPorts } from '../../features/agent-controls/ports';
import { useConversationIndex } from './ConversationIndexRoute';
import type { HumanRouteCodec } from './routes';
import { createHumanPendingSendStore } from './pending-send-store';

type ReviewClient = ReturnType<typeof createOwnerMailboxReviewClient>;
type ReviewRoomId = Parameters<HumanRoomRenderer>[1]['roomId'];

function reviewIdentity(context: Parameters<HumanRoomRenderer>[0], roomId: ReviewRoomId,
  binding: OwnerReviewBinding): string {
  return JSON.stringify([context.principal.ownerId, context.generation, roomId,
    binding.bindingId, binding.generation, binding.agentParticipantId, binding.device]);
}
function reviewScope(context: Parameters<HumanRoomRenderer>[0], roomId: ReviewRoomId): string {
  return JSON.stringify([context.principal.ownerId, context.generation, roomId]);
}

const unavailablePresence: ChannelUiPort = {
  async agents() { throw new Error('agent presence unavailable'); },
  subscribeAgents: () => () => undefined,
  async installCommand() { throw new Error('agent onboarding unavailable'); },
};

export const renderHumanRoom: HumanRoomRenderer = (context, route, navigate, routes) => (
  <HumanRoom key={`${context.principal.ownerId}:${context.generation}:${route.roomId}`} context={context} roomId={route.roomId}
    {...(navigate && routes ? { navigate, routes } : {})} />
);

/** Production room renderer with the authenticated owner mailbox attached. */
export function createHumanRoomRenderer(review: ReviewClient, capability: ReviewCapability,
  trustBinding: (context: Parameters<HumanRoomRenderer>[0], roomId: ReviewRoomId,
    binding: OwnerReviewBinding) => Promise<boolean>, refreshMs = 5_000,
  controls?: ControlsCapability): HumanRoomRenderer {
  return (context, route, navigate, routes) => <HumanRoom key={`${context.principal.ownerId}:${context.generation}:${route.roomId}`} context={context} roomId={route.roomId}
    {...(navigate && routes ? { navigate, routes } : {})} review={review}
    capability={capability} trustBinding={trustBinding} refreshMs={refreshMs}
    {...(controls ? { controls } : {})} />;
}

function ControlsForBinding({ context, roomId, capability, binding }: {
  context: Parameters<HumanRoomRenderer>[0];
  roomId: ReviewRoomId;
  capability: ControlsCapability;
  binding: OwnerReviewBinding;
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
  if (!ports) return <Panel heading="Agent controls"><p role="status">Loading controls…</p></Panel>;
  return <AgentControlsPanel ports={ports} config={{
    bindingId: binding.bindingId, roomId, peerParticipantId: binding.agentParticipantId as never,
    viewerOwnerId: context.principal.ownerId, agentLabel: binding.agentParticipantId, roomLabel: roomId,
  }} />;
}

function HumanControls({ context, roomId, review, capability, refreshMs }: {
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

function HumanReview({ context, roomId, review, capability, trustBinding, refreshMs }: {
  context: Parameters<HumanRoomRenderer>[0];
  roomId: Parameters<HumanRoomRenderer>[1]['roomId'];
  review: ReviewClient | undefined;
  capability: ReviewCapability | undefined;
  trustBinding: ((context: Parameters<HumanRoomRenderer>[0], roomId: ReviewRoomId,
    binding: OwnerReviewBinding) => Promise<boolean>) | undefined;
  refreshMs: number;
}) {
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
            pending = Promise.resolve().then(() => trustBinding(context, roomId, binding)).catch(() => false);
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
  if (!review || !capability || !trustBinding || discovery === null || discovery.scope !== scope) {
    return <Panel heading="Recipient review"><p role="status">Review unavailable or loading.</p></Panel>;
  }
  if (discovery.active === 0) return <Panel heading="Recipient review"><p role="status">No active agent recipient in this channel.</p></Panel>;
  if (discovery.bindings.length === 0) return <Panel heading="Recipient review"><p role="status">Waiting for verified agent device trust.</p></Panel>;
  return <>{discovery.bindings.map(binding => <ReviewForBinding key={reviewIdentity(context, roomId, binding)} context={context} roomId={roomId}
    capability={capability} binding={binding} />)}</>;
}

function HumanRoom({ context, roomId, navigate, routes, review, capability, trustBinding, refreshMs = 5_000, controls }: {
  context: Parameters<HumanRoomRenderer>[0];
  roomId: Parameters<HumanRoomRenderer>[1]['roomId'];
  navigate?: (path: string) => void;
  routes?: HumanRouteCodec;
  review?: ReviewClient;
  capability?: ReviewCapability;
  controls?: ControlsCapability;
  trustBinding?: (context: Parameters<HumanRoomRenderer>[0], roomId: ReviewRoomId,
    binding: OwnerReviewBinding) => Promise<boolean>;
  refreshMs?: number;
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
  const room = useMemo(
    () => createChannelController(unavailablePresence, { roomId, generation: context.generation }),
    [context.generation, roomId],
  );
  const recovery = useMemo(() => createBrowserRecoveryPort({
    principal: context.principal, identity: context.identity, device: context.device,
    ...(context.room.observeEntries ? { historyEntries: { roomId, observeEntries: context.room.observeEntries } } : {}),
    resumeStore: sessionResumeStore(context.principal.ownerId, roomId),
    ...(context.closure ? { closure: context.closure(roomId) } : {}),
    ...(context.revocation ? { revocation: context.revocation(roomId) } : {}),
  }), [context, roomId]);
  useEffect(() => () => {
    timeline.dispose();
    room.dispose();
    recovery.dispose();
  }, [room, timeline, recovery]);
  const viewer = context.participant?.() ?? null;
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

  return (
    <ChannelScreen
      embedded={Boolean(context.conversations && routes && navigate)}
      title={selectedConversation?.title ?? 'Encrypted conversation'}
      controller={room}
      renderShare={() => context.admission ? <ChannelSharePanel key={`${context.principal.ownerId}:${context.generation}:${roomId}`}
        admission={context.admission} roomId={roomId} roomTitle={selectedConversation?.title ?? 'Encrypted conversation'} /> : null}
      renderTimeline={() => (
        <TimelineScreen key={JSON.stringify([context.principal.ownerId, deviceId, context.generation, roomId])}
          controller={timeline} roomPort={context.room} roomId={roomId} viewer={viewer}
          {...(pendingStore ? { pendingStore } : {})}
          unreadableActivity={selectedConversation?.preview === null && selectedConversation.timestamp !== null} />
      )}
      renderReview={() => <HumanReview context={context} roomId={roomId} review={review} capability={capability}
        trustBinding={trustBinding} refreshMs={refreshMs} />}
      renderControls={() => (
        <>
          <HumanControls context={context} roomId={roomId} review={review} capability={controls} refreshMs={refreshMs} />
          <RecoveryPanel ports={recovery} config={{ roomId, roomRevision: 0 }} onClosureParticipationEnded={() => location.assign('/')} />
        </>
      )}
    />
  );
}
