import { useEffect, useMemo, useState } from 'react';
import { decodeDeliveryLimits } from '@khala/contracts/delivery/index';
import { createChannelController } from '../../features/channel/controller';
import type { ChannelUiPort } from '../../features/channel/ports';
import { ChannelScreen } from '../../features/channel/ChannelScreen';
import { createTimelineController } from '../../features/timeline/controller';
import { TimelineScreen } from '../../features/timeline/TimelineScreen';
import { Panel } from '../../shell/Panel';
import { RecoveryPanel } from '../../features/recovery/RecoveryPanel';
import { createBrowserRecoveryPort } from '../recovery/browser-port';
import type { HumanRoomRenderer } from './mount';
import { registerReview } from '../review/register';
import { createReviewController, type ReviewController } from '../../features/review/controller';
import { ReviewScreen } from '../../features/review/ReviewScreen';
import type { OwnerReviewBinding } from '../review/owner-mailbox-client';
import { createOwnerMailboxReviewClient } from '../review/owner-mailbox-client';

const reviewLimits = (() => {
  const decoded = decodeDeliveryLimits({ maxSelectionEvents: 20, maxPayloadBytes: 64 * 1024 });
  if (!decoded.ok) throw new Error('invalid_review_limits');
  return decoded.value;
})();
type ReviewClient = ReturnType<typeof createOwnerMailboxReviewClient>;

const unavailablePresence: ChannelUiPort = {
  async agents() { throw new Error('agent presence unavailable'); },
  subscribeAgents: () => () => undefined,
  async installCommand() { throw new Error('agent onboarding unavailable'); },
};

export const renderHumanRoom: HumanRoomRenderer = (context, route) => (
  <HumanRoom context={context} roomId={route.roomId} />
);

/** Production room renderer with the authenticated owner mailbox attached. */
export function createHumanRoomRenderer(review: ReviewClient): HumanRoomRenderer {
  return (context, route) => <HumanRoom context={context} roomId={route.roomId} review={review} />;
}

function ReviewForBinding({ context, roomId, review, binding }: {
  context: Parameters<HumanRoomRenderer>[0];
  roomId: Parameters<HumanRoomRenderer>[1]['roomId'];
  review: ReviewClient;
  binding: OwnerReviewBinding;
}) {
  const [controller, setController] = useState<ReviewController | null>(null);
  useEffect(() => {
    const capability = registerReview({ client: review.review, limits: reviewLimits,
      bindingFor: () => binding });
    const lease = capability.attach(context);
    const port = capability.portFor(context, roomId);
    if (!port) { lease.dispose(); return; }
    const active = createReviewController(port);
    setController(active);
    return () => { active.dispose(); lease.dispose(); };
  }, [binding.bindingId, binding.generation, context, review, roomId]);
  return controller ? <ReviewScreen controller={controller} recipientLabel={binding.agentParticipantId}
    renderContent={content => <span dir="auto">{content.body}</span>} /> : <Panel heading="Recipient review"><p role="status">Loading review…</p></Panel>;
}

function HumanReview({ context, roomId, review }: {
  context: Parameters<HumanRoomRenderer>[0];
  roomId: Parameters<HumanRoomRenderer>[1]['roomId'];
  review: ReviewClient | undefined;
}) {
  const [bindings, setBindings] = useState<readonly OwnerReviewBinding[] | null>(null);
  useEffect(() => {
    if (!review) return;
    const abort = new AbortController();
    setBindings(null);
    const refresh = () => { void review.bindings(roomId, abort.signal).then(value => {
      if (!abort.signal.aborted) setBindings(value);
    }); };
    refresh();
    const timer = setInterval(refresh, 5_000);
    return () => { abort.abort(); clearInterval(timer); };
  }, [context, roomId, review]);
  if (!review || bindings === null) return <Panel heading="Recipient review"><p role="status">Review unavailable or loading.</p></Panel>;
  if (bindings.length === 0) return <Panel heading="Recipient review"><p role="status">No active agent recipient in this channel.</p></Panel>;
  return <>{bindings.map(binding => <ReviewForBinding key={`${binding.bindingId}:${binding.generation}`} context={context} roomId={roomId}
    review={review} binding={binding} />)}</>;
}

function HumanRoom({ context, roomId, review }: {
  context: Parameters<HumanRoomRenderer>[0];
  roomId: Parameters<HumanRoomRenderer>[1]['roomId'];
  review?: ReviewClient;
}) {
  const timeline = useMemo(
    () => createTimelineController(context.room, roomId, { generation: context.generation, pageSize: 50 }),
    [context.generation, context.room, roomId],
  );
  const room = useMemo(
    () => createChannelController(unavailablePresence, { roomId, generation: context.generation }),
    [context.generation, roomId],
  );
  const recovery = useMemo(() => createBrowserRecoveryPort({
    principal: context.principal, identity: context.identity, device: context.device,
    ...(context.closure ? { closure: context.closure(roomId) } : {}),
    ...(context.revocation ? { revocation: context.revocation(roomId) } : {}),
  }), [context, roomId]);
  useEffect(() => () => {
    timeline.dispose();
    room.dispose();
    recovery.dispose();
  }, [room, timeline, recovery]);
  const viewer = context.participant?.() ?? null;
  if (viewer === null) {
    return (
      <Panel heading="Conversation unavailable">
        <p role="alert">Participant attribution is unavailable for this session.</p>
      </Panel>
    );
  }

  return (
    <ChannelScreen
      title="Khala conversation"
      description="Encrypted messages shared by admitted participants."
      controller={room}
      renderTimeline={() => (
        <TimelineScreen controller={timeline} roomPort={context.room} roomId={roomId} viewer={viewer} />
      )}
      renderReview={() => <HumanReview context={context} roomId={roomId} review={review} />}
      renderControls={() => (
        <>
          <Panel heading="Agent controls">
            <p role="status">Agent controls are not available for this channel yet.</p>
          </Panel>
          <RecoveryPanel ports={recovery} config={{ roomId, roomRevision: 0 }} onClosureParticipationEnded={() => location.assign('/')} />
        </>
      )}
    />
  );
}
