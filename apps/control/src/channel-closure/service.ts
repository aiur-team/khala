import { createHash } from 'node:crypto';
import {
  CLOSURE_CONSEQUENCES, decodeClosureRequest, ok, outcomeUnknown, rejected, unavailable,
  type AuthPrincipal, type CallOptions, type ClosureCapability, type ClosurePort, type ClosureRequest,
  type ClosureStatus, type ControlStore, type OwnerId, type RoomId,
} from '@khala/contracts/messaging/index';

/** A server-side owner account adapter. `leave` must be safe to repeat. */
export interface ClosureTransport {
  membership(ownerId: OwnerId, roomId: RoomId, options?: CallOptions): Promise<'joined' | 'left' | 'forbidden' | 'unavailable'>;
  leave(ownerId: OwnerId, roomId: RoomId, options?: CallOptions): Promise<'left' | 'forbidden' | 'unknown'>;
  /** Best-effort signal to clear this owner's local browser/connector state. */
  requestLocalCleanup(ownerId: OwnerId, roomId: RoomId, options?: CallOptions): Promise<'requested' | 'unavailable'>;
}

type Intent = Readonly<{ ownerId: OwnerId; roomId: RoomId; expectedRoomRevision: number }>;
type Marker = Intent & Readonly<{ operationId: string; state: ClosureStatus['state']; reason: ClosureStatus['reason'] }>;

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const operationKey = (id: string) => `channel-closure:operation:${digest(id)}`;
const channelKey = (owner: OwnerId, room: RoomId) => `channel-closure:channel:${digest(JSON.stringify([owner, room]))}`;

function marker(value: unknown): Marker | null {
  const item = value as Partial<Marker> | null;
  if (!item || typeof item !== 'object') return null;
  const request = decodeClosureRequest({
    operationId: item.operationId, ownerId: item.ownerId,
    roomId: item.roomId, expectedRoomRevision: item.expectedRoomRevision,
  });
  if (!request.ok) return null;
  if (item.state !== 'pending' && item.state !== 'partial' && item.state !== 'complete' && item.state !== 'failed') return null;
  return { ...request.value, state: item.state, reason: item.reason ?? null };
}

const status = (value: Marker): ClosureStatus => ({ operationId: value.operationId, state: value.state, reason: value.reason });
const matches = (a: Intent, b: Intent) => a.ownerId === b.ownerId && a.roomId === b.roomId
  && a.expectedRoomRevision === b.expectedRoomRevision;

/**
 * Durable per-owner/channel closure gate. The marker is written before a transport
 * leave; a retry resumes the same operation. A completed response requires the
 * owner's leave and the local cleanup request to have both been acknowledged.
 */
export function createChannelClosureService(input: Readonly<{
  principal: AuthPrincipal;
  store: ControlStore;
  transport: ClosureTransport;
}>): ClosurePort {
  const { principal, store, transport } = input;

  async function inspect(operationId: string, options?: CallOptions) {
    const claim = await store.read<Marker>(operationKey(operationId), options);
    if (claim.kind === 'unavailable') return unavailable();
    if (claim.kind === 'absent') return rejected('not_found' as const);
    const intent = marker(claim.record.value);
    if (!intent || intent.ownerId !== principal.ownerId) return rejected('forbidden' as const);
    const current = await store.read<Marker>(channelKey(intent.ownerId, intent.roomId), options);
    if (current.kind === 'unavailable') return unavailable();
    if (current.kind === 'absent') return ok(status({ ...intent, state: 'pending', reason: null }));
    const value = marker(current.record.value);
    return value && value.operationId === operationId ? ok(status(value)) : rejected('not_found' as const);
  }

  return {
    async capability(roomId, options) {
      const current = await store.read<Marker>(channelKey(principal.ownerId, roomId), options);
      if (current.kind === 'unavailable') return unavailable();
      const membership = await transport.membership(principal.ownerId, roomId, options).catch(() => 'unavailable' as const);
      if (membership === 'unavailable') return unavailable();
      const available = current.kind === 'absent' && membership === 'joined';
      const value: ClosureCapability = {
        ownerId: principal.ownerId, roomId, expectedRoomRevision: 0, available,
        unavailableReason: available ? null : membership === 'forbidden' ? 'forbidden' : 'stale_room',
        consequences: CLOSURE_CONSEQUENCES,
      };
      return ok(value);
    },
    async closeRoom(request: ClosureRequest, options) {
      const decoded = decodeClosureRequest(request);
      if (!decoded.ok) return rejected('forbidden');
      if (request.ownerId !== principal.ownerId) return rejected('forbidden');
      if (request.expectedRoomRevision !== 0) return rejected('stale_room');

      const opKey = operationKey(request.operationId);
      const known = await store.read<Marker>(opKey, options);
      if (known.kind === 'unavailable') return unavailable();
      if (known.kind === 'absent') {
        const membership = await transport.membership(request.ownerId, request.roomId, options).catch(() => 'unavailable' as const);
        if (membership === 'unavailable') return unavailable();
        if (membership === 'forbidden') return rejected('forbidden');
        if (membership !== 'joined') return rejected('stale_room');
      }
      const intent: Marker = { ...request, state: 'pending', reason: null };
      const operation = await store.compareAndSet({ key: opKey, expectedRevision: null, operationId: `${request.operationId}:intent`,
        next: { value: intent, expiresAt: null } }, options);
      if (operation.kind === 'unavailable') return unavailable();
      if (operation.kind === 'outcome_unknown') return outcomeUnknown(request.operationId);
      if (operation.kind === 'operation_mismatch') return rejected('operation_mismatch');
      const prior = operation.kind === 'conflict' ? marker(operation.current?.value) : intent;
      if (!prior || !matches(prior, request)) return rejected('operation_mismatch');

      const key = channelKey(request.ownerId, request.roomId);
      const observed = await store.read<Marker>(key, options);
      if (observed.kind === 'unavailable') return unavailable();
      if (observed.kind === 'record' && observed.record.value.operationId !== request.operationId) return rejected('stale_room');
      const claimed = observed.kind === 'record' ? null : await store.compareAndSet({ key, expectedRevision: null,
        operationId: `${request.operationId}:gate`, next: { value: intent, expiresAt: null } }, options);
      if (claimed?.kind === 'unavailable') return unavailable();
      if (claimed?.kind === 'outcome_unknown') return outcomeUnknown(request.operationId);
      if (claimed?.kind === 'operation_mismatch') return rejected('operation_mismatch');
      const existing = observed.kind === 'record' ? marker(observed.record.value)
        : claimed?.kind === 'conflict' ? marker(claimed.current?.value) : intent;
      if (!existing || existing.operationId !== request.operationId || !matches(existing, request)) return rejected('stale_room');
      if (existing.state === 'complete') return ok(status(existing));

      // Never claim completion from a local record alone: the transport may be
      // offline, and a marker cannot remove a remote participant by itself.
      const left = await transport.leave(request.ownerId, request.roomId, options).catch(() => 'unknown' as const);
      const cleanup = left === 'left'
        ? await transport.requestLocalCleanup(request.ownerId, request.roomId, options).catch(() => 'unavailable' as const)
        : 'unavailable';
      const next: Marker = {
        ...intent,
        state: left === 'left' && cleanup === 'requested' ? 'complete' : 'partial',
        reason: left !== 'left' ? 'dependency_unavailable' : cleanup === 'requested' ? null : 'local_cleanup_failed',
      };
      const revision = observed.kind === 'record' ? observed.record.revision
        : claimed?.kind === 'applied' ? claimed.record.revision : claimed?.current?.revision;
      if (!revision) return outcomeUnknown(request.operationId);
      const written = await store.compareAndSet({ key, expectedRevision: revision, operationId: `${request.operationId}:status:${revision}`,
        next: { value: next, expiresAt: null } }, options);
      if (written.kind === 'applied') return ok(status(next));
      if (written.kind === 'conflict') {
        const observed = marker(written.current?.value);
        return observed?.operationId === request.operationId ? ok(status(observed)) : rejected('stale_room');
      }
      return outcomeUnknown(request.operationId);
    },
    inspectClosure: inspect,
  };
}
