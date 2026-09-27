import type { AuthPrincipal, ControlStore, OwnerId, RoomId } from '@khala/contracts/messaging/index';
import { createAgentBindingStore } from '../../agent-bootstrap/store';
import { createOwnerRoomIndex } from '../../agent-bootstrap/owner-room-index';
import { createOwnerMailbox } from './store';

type ClosureRequest = Readonly<{
  operationId: string; ownerId: OwnerId; roomId: RoomId; expectedRoomRevision: number;
}>;
type StopResult = Readonly<{ kind: 'pending' | 'unavailable' }> | Readonly<{
  kind: 'stopped';
  receipt: ClosureRequest & Readonly<{
    markerRevision: number; activeBindingCount: number;
    fencedBindings: readonly Readonly<{ bindingId: string; generation: number }>[];
    state: 'stopped'; futureBindingAdmissionBlocked: true; relayPollBlocked: true;
    relayIntakeBlocked: true; modelDispatchBlocked: true; cleanupRequested: true;
  }>;
}>;

/** Server-side aggregate: only endpoint receipts for every indexed binding can permit Matrix leave. */
export function createOwnerRoomClosureConnector(input: Readonly<{
  store: ControlStore; principal: AuthPrincipal; clock: () => number; authoritySecret: string;
}>): Readonly<{ stopDelivery(request: ClosureRequest): Promise<StopResult> }> {
  const index = createOwnerRoomIndex(input.store);
  const bindings = createAgentBindingStore({ store: input.store });
  return {
    async stopDelivery(request) {
      if (request.ownerId !== input.principal.ownerId || request.expectedRoomRevision !== 0) return { kind: 'unavailable' };
      const marked = await index.markClosing(request.ownerId, request.roomId, request.operationId, request.expectedRoomRevision);
      if (marked.kind !== 'ok') return { kind: marked.kind === 'closed' ? 'pending' : 'unavailable' };
      const fenced: Array<{ bindingId: string; generation: number }> = [];
      let pending = false;
      for (const item of marked.value.bindings) {
        const found = await bindings.locateBinding(item.bindingId);
        if (found.kind !== 'found' || found.address.ownerId !== request.ownerId || found.address.roomId !== request.roomId
          || found.record.binding.generation !== item.generation) return { kind: 'unavailable' };
        const mailbox = createOwnerMailbox({ store: input.store, binding: found.record.binding, roomId: request.roomId,
          clock: input.clock, authoritySecret: input.authoritySecret });
        const submitted = await mailbox.submit({ operationId: request.operationId, kind: 'channel_stop', body: request }, input.principal);
        if (submitted.kind !== 'ok') return { kind: 'unavailable' };
        const outcome = submitted.value.outcome;
        if (outcome === null) {
          pending = true;
          continue;
        }
        if (typeof outcome !== 'object' || Array.isArray(outcome) || outcome === null) return { kind: 'unavailable' };
        const answered = outcome as Record<string, unknown>;
        if (answered.kind !== 'stopped' || typeof answered.receipt !== 'object'
          || answered.receipt === null || Array.isArray(answered.receipt)) return { kind: 'unavailable' };
        const receipt = answered.receipt as Record<string, unknown>;
        if (receipt.operationId !== request.operationId || receipt.ownerId !== request.ownerId
          || receipt.roomId !== request.roomId || receipt.expectedRoomRevision !== request.expectedRoomRevision
          || receipt.bindingId !== item.bindingId || receipt.bindingGeneration !== item.generation
          || receipt.state !== 'stopped' || receipt.cleanupRequested !== true) return { kind: 'unavailable' };
        fenced.push(item);
      }
      if (pending) return { kind: 'pending' };
      return { kind: 'stopped', receipt: {
        ...request, markerRevision: marked.value.revision, activeBindingCount: marked.value.bindings.length,
        fencedBindings: fenced, state: 'stopped', futureBindingAdmissionBlocked: true,
        relayPollBlocked: true, relayIntakeBlocked: true, modelDispatchBlocked: true, cleanupRequested: true,
      } };
    },
  };
}
