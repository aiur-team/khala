import { createHash } from 'node:crypto';
import type { ControlStore, JsonValue, OwnerId, RoomId, SessionBinding } from '@khala/contracts/messaging/index';

export type IndexedBinding = Readonly<{ bindingId: string; generation: number }>;
export type OwnerRoomIndex = Readonly<{
  v: 1; ownerId: OwnerId; roomId: RoomId; revision: number;
  marker: Readonly<{ operationId: string; expectedRoomRevision: number }> | null;
  bindings: readonly IndexedBinding[];
}>;
export type IndexResult<T> = Readonly<{ kind: 'ok'; value: T }> | Readonly<{ kind: 'closed' | 'unavailable' | 'conflict' }>;
const MAX_BINDINGS = 128;

function key(ownerId: OwnerId, roomId: RoomId): string {
  return `agent-room-index.v1.${createHash('sha256').update(JSON.stringify([ownerId, roomId])).digest('hex')}`;
}
function valid(value: unknown, ownerId: OwnerId, roomId: RoomId): value is OwnerRoomIndex {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'bindings,marker,ownerId,revision,roomId,v'
    || record.v !== 1 || record.ownerId !== ownerId || record.roomId !== roomId
    || !Number.isSafeInteger(record.revision) || (record.revision as number) < 0
    || !Array.isArray(record.bindings) || record.bindings.length > MAX_BINDINGS) return false;
  const identities = new Set<string>();
  for (const binding of record.bindings) {
    if (typeof binding !== 'object' || binding === null || Array.isArray(binding)) return false;
    const item = binding as Record<string, unknown>;
    if (Object.keys(item).sort().join(',') !== 'bindingId,generation' || typeof item.bindingId !== 'string'
      || !/^[A-Za-z0-9_-]{3,128}$/u.test(item.bindingId) || !Number.isSafeInteger(item.generation)
      || (item.generation as number) < 0 || identities.has(item.bindingId)) return false;
    identities.add(item.bindingId);
  }
  if (record.marker === null) return true;
  if (typeof record.marker !== 'object' || Array.isArray(record.marker)) return false;
  const marker = record.marker as Record<string, unknown>;
  return Object.keys(marker).sort().join(',') === 'expectedRoomRevision,operationId'
    && typeof marker.operationId === 'string' && /^[A-Za-z0-9_-]{3,128}$/u.test(marker.operationId)
    && Number.isSafeInteger(marker.expectedRoomRevision) && (marker.expectedRoomRevision as number) >= 0;
}

/** The marker and active binding list share one CAS record, so closure cannot miss a racing activation. */
export function createOwnerRoomIndex(store: ControlStore) {
  async function read(ownerId: OwnerId, roomId: RoomId): Promise<IndexResult<Readonly<{ value: OwnerRoomIndex | null; revision: string | null }>>> {
    const found = await store.read<JsonValue>(key(ownerId, roomId));
    if (found.kind === 'unavailable') return { kind: 'unavailable' };
    if (found.kind === 'absent') return { kind: 'ok', value: { value: null, revision: null } };
    return valid(found.record.value, ownerId, roomId)
      ? { kind: 'ok', value: { value: found.record.value, revision: found.record.revision } }
      : { kind: 'unavailable' };
  }
  async function put(value: OwnerRoomIndex, expectedRevision: string | null): Promise<'applied' | 'conflict' | 'unavailable'> {
    const operationId = `agent-room-index.${createHash('sha256').update(JSON.stringify([expectedRevision, value])).digest('base64url')}`;
    const result = await store.compareAndSet<JsonValue>({ key: key(value.ownerId, value.roomId), expectedRevision,
      operationId, next: { value: value as unknown as JsonValue, expiresAt: null } });
    return result.kind === 'applied' ? 'applied' : result.kind === 'conflict' ? 'conflict' : 'unavailable';
  }
  return {
    async activate(binding: SessionBinding, roomId: RoomId): Promise<IndexResult<OwnerRoomIndex>> {
      for (let attempt = 0; attempt < 8; attempt++) {
        const found = await read(binding.ownerId, roomId);
        if (found.kind !== 'ok') return found;
        const { value, revision } = found.value;
        if (value?.marker) return { kind: 'closed' };
        const prior = value?.bindings.find(item => item.bindingId === binding.bindingId);
        if (prior) return prior.generation === binding.generation ? { kind: 'ok', value: value! } : { kind: 'conflict' };
        if ((value?.bindings.length ?? 0) >= MAX_BINDINGS) return { kind: 'unavailable' };
        const next: OwnerRoomIndex = { v: 1, ownerId: binding.ownerId, roomId,
          revision: (value?.revision ?? 0) + 1, marker: null,
          bindings: [...(value?.bindings ?? []), { bindingId: binding.bindingId, generation: binding.generation }] };
        const written = await put(next, revision);
        if (written === 'applied') return { kind: 'ok', value: next };
        if (written === 'unavailable') return { kind: 'unavailable' };
      }
      return { kind: 'unavailable' };
    },
    async markClosing(ownerId: OwnerId, roomId: RoomId, operationId: string, expectedRoomRevision: number): Promise<IndexResult<OwnerRoomIndex>> {
      if (!/^[A-Za-z0-9_-]{3,128}$/u.test(operationId) || !Number.isSafeInteger(expectedRoomRevision)
        || expectedRoomRevision < 0) return { kind: 'conflict' };
      for (let attempt = 0; attempt < 8; attempt++) {
        const found = await read(ownerId, roomId);
        if (found.kind !== 'ok') return found;
        const { value, revision } = found.value;
        // An absent index cannot prove that older admitted connectors were enumerated.
        if (!value) return { kind: 'unavailable' };
        if (value.marker) return value.marker.operationId === operationId
          && value.marker.expectedRoomRevision === expectedRoomRevision ? { kind: 'ok', value } : { kind: 'closed' };
        const next: OwnerRoomIndex = { ...value, revision: value.revision + 1,
          marker: { operationId, expectedRoomRevision } };
        const written = await put(next, revision);
        if (written === 'applied') return { kind: 'ok', value: next };
        if (written === 'unavailable') return { kind: 'unavailable' };
      }
      return { kind: 'unavailable' };
    },
    async inspect(ownerId: OwnerId, roomId: RoomId): Promise<IndexResult<OwnerRoomIndex | null>> {
      const found = await read(ownerId, roomId);
      return found.kind === 'ok' ? { kind: 'ok', value: found.value.value } : found;
    },
  };
}
