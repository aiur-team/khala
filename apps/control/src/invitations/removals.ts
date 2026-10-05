import { createHash, randomUUID } from 'node:crypto';
import type { CallOptions, ControlStore, OwnerId, RoomId } from '@khala/contracts/messaging/index';
import type { InviteRecord } from './policy';

export type RoomRemovals = Readonly<{ v: 1; creatorOwnerId: string; generation: number;
  owners: Readonly<Record<string, Readonly<{ generation: number; agents: readonly string[]; label: string; complete: boolean }>>> }>;
function validRemovals(value: unknown): value is RoomRemovals {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as RoomRemovals;
  return record.v === 1 && typeof record.creatorOwnerId === 'string' && Number.isSafeInteger(record.generation)
    && record.generation > 0 && typeof record.owners === 'object' && record.owners !== null && !Array.isArray(record.owners)
    && Object.values(record.owners).every(entry => typeof entry === 'object' && entry !== null
      && Number.isSafeInteger(entry.generation) && entry.generation > 0 && entry.generation <= record.generation
      && typeof entry.label === 'string' && typeof entry.complete === 'boolean' && Array.isArray(entry.agents)
      && entry.agents.every(agent => typeof agent === 'string'));
}
const key = (roomId: RoomId) => `channel.removals.v1.${createHash('sha256').update(roomId).digest('hex')}`;
export async function readRoomRemovals(store: ControlStore, roomId: RoomId, call?: CallOptions): Promise<RoomRemovals | null | 'unavailable'> {
  try {
    const read = await store.read(key(roomId), call);
    if (read.kind === 'absent') return null;
    if (read.kind !== 'record') return 'unavailable';
    const value = read.record.value as unknown as RoomRemovals;
    return validRemovals(value) ? value : 'unavailable';
  } catch { return 'unavailable'; }
}
/** Persist before kicking: retries retain agents already absent from the live roster. */
export async function recordRemoval(store: ControlStore, roomId: RoomId, creatorOwnerId: OwnerId, ownerId: OwnerId,
  agents: readonly string[], label: string, call?: CallOptions): Promise<RoomRemovals | 'unavailable'> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const read = await store.read<RoomRemovals>(key(roomId), call);
    if (read.kind === 'unavailable') return 'unavailable';
    const previous = read.kind === 'record' ? read.record.value : null;
    if (previous && (!validRemovals(previous) || previous.creatorOwnerId !== creatorOwnerId)) return 'unavailable';
    const pending = previous?.owners[ownerId];
    const generation = pending && !pending.complete ? pending.generation : (previous?.generation ?? 0) + 1;
    const value: RoomRemovals = { v: 1, creatorOwnerId, generation: Math.max(generation, previous?.generation ?? 0),
      owners: { ...previous?.owners, [ownerId]: { generation, label, complete: false, agents: [...new Set([...(previous?.owners[ownerId]?.agents ?? []), ...agents])] } } };
    const written = await store.compareAndSet({ key: key(roomId), expectedRevision: read.kind === 'record' ? read.record.revision : null,
      operationId: `channel.remove.${randomUUID()}`, next: { value, expiresAt: null } }, call);
    if (written.kind === 'applied') return written.record.value;
    if (written.kind !== 'conflict') return 'unavailable';
  }
  return 'unavailable';
}
export async function inviteRemovalState(store: ControlStore, invite: InviteRecord, ownerId?: OwnerId, call?: CallOptions): Promise<'allowed' | 'revoked' | 'unavailable'> {
  const removals = await readRoomRemovals(store, invite.roomId, call);
  if (removals === 'unavailable') return removals;
  if (!removals) return 'allowed';
  const generation = invite.removalGeneration ?? 0;
  const issuer = removals.owners[invite.creatorOwnerId];
  if (issuer && generation < issuer.generation) return 'revoked';
  const target = ownerId ? removals.owners[ownerId] : null;
  return target && (!target.complete || generation < target.generation || invite.creatorOwnerId !== removals.creatorOwnerId) ? 'revoked' : 'allowed';
}

export async function completeRemoval(store: ControlStore, roomId: RoomId, ownerId: OwnerId, generation: number): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const read = await store.read<RoomRemovals>(key(roomId));
    if (read.kind !== 'record') return false;
    const current = read.record.value;
    if (!validRemovals(current)) return false;
    const entry = current.owners[ownerId];
    if (!entry || entry.generation !== generation) return false;
    if (entry.complete) return true;
    const value: RoomRemovals = { ...current, owners: { ...current.owners, [ownerId]: { ...entry, complete: true } } };
    const result = await store.compareAndSet({ key: key(roomId), expectedRevision: read.record.revision,
      operationId: `channel.remove.complete.${randomUUID()}`, next: { value, expiresAt: null } });
    if (result.kind === 'applied') return true;
    if (result.kind !== 'conflict') return false;
  }
  return false;
}
