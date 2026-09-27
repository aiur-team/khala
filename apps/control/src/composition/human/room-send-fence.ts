import { createHash } from 'node:crypto';
import type { ControlStore, JsonValue, RoomId } from '@khala/contracts/messaging/index';
import { guardStore, settleWrite } from '../../auth/store';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_SENDERS = 128;
const MAX_ACTIVE = 128;
export type SenderIdentity = Readonly<{ senderId: string; deviceId: string; deviceKey: string }>;
type Sender = SenderIdentity & Readonly<{ rotatedEpoch: number }>;
type Hold = Readonly<{ operationId: string; excludedDeviceKey: string; epoch: number }>;
type RoomFence = Readonly<{ v: 1; roomId: RoomId; revision: number; epoch: number;
  hold: Hold | null; senders: readonly Sender[]; activePermits: readonly string[] }>;
type Permit = Readonly<{ v: 1; roomId: RoomId; senderId: string; clientTxnId: string;
  permitId: string; state: 'active' | 'unknown' | 'complete'; eventId: string | null }>;

function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function roomKey(roomId: RoomId): string { return `room-send-fence.v1.${hash(roomId)}`; }
function permitKey(permitId: string): string { return `room-send-permit.v1.${hash(permitId)}`; }
function permitId(roomId: RoomId, senderId: string, clientTxnId: string): string {
  return `permit_${hash([roomId, senderId, clientTxnId])}`;
}
function writeId(value: unknown): string { return `room-send-fence.${hash(value)}`; }
function validRoom(value: JsonValue, roomId: RoomId): value is RoomFence & JsonValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, JsonValue>;
  return Object.keys(row).sort().join(',') === 'activePermits,epoch,hold,revision,roomId,senders,v'
    && row.v === 1 && row.roomId === roomId && Number.isSafeInteger(row.revision) && Number.isSafeInteger(row.epoch)
    && Array.isArray(row.activePermits) && row.activePermits.length <= MAX_ACTIVE
    && row.activePermits.every(id => typeof id === 'string' && ID.test(id))
    && Array.isArray(row.senders) && row.senders.length <= MAX_SENDERS
    && row.senders.every(sender => typeof sender === 'object' && sender !== null && !Array.isArray(sender)
      && Object.keys(sender).sort().join(',') === 'deviceId,deviceKey,rotatedEpoch,senderId'
      && typeof sender.senderId === 'string' && ID.test(sender.senderId)
      && typeof sender.deviceId === 'string' && ID.test(sender.deviceId)
      && typeof sender.deviceKey === 'string' && /^[A-Za-z0-9+/]{43}=?$/u.test(sender.deviceKey)
      && Number.isSafeInteger(sender.rotatedEpoch))
    && (row.hold === null || typeof row.hold === 'object' && !Array.isArray(row.hold)
      && typeof (row.hold as Record<string, JsonValue>).operationId === 'string'
      && ID.test(String((row.hold as Record<string, JsonValue>).operationId))
      && typeof (row.hold as Record<string, JsonValue>).excludedDeviceKey === 'string'
      && /^[A-Za-z0-9+/]{43}=?$/u.test(String((row.hold as Record<string, JsonValue>).excludedDeviceKey))
      && Number.isSafeInteger((row.hold as Record<string, JsonValue>).epoch));
}
function validPermit(value: JsonValue, id: string): value is Permit & JsonValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, JsonValue>;
  return Object.keys(row).sort().join(',') === 'clientTxnId,eventId,permitId,roomId,senderId,state,v'
    && row.v === 1 && row.permitId === id && typeof row.roomId === 'string'
    && typeof row.senderId === 'string' && typeof row.clientTxnId === 'string'
    && ['active', 'unknown', 'complete'].includes(String(row.state))
    && (row.eventId === null || typeof row.eventId === 'string');
}

/** Durable room-wide send barrier. Unknown Matrix outcomes remain active until the same txn settles. */
export function createRoomSendFence(store: ControlStore) {
  const guarded = guardStore(store);
  async function readRoom(roomId: RoomId) {
    const found = await guarded.read<JsonValue>(roomKey(roomId));
    if (found.kind === 'unavailable') return { kind: 'unavailable' as const };
    if (found.kind === 'absent') return { kind: 'found' as const, revision: null as string | null,
      value: { v: 1, roomId, revision: 0, epoch: 0, hold: null, senders: [], activePermits: [] } as RoomFence };
    return validRoom(found.record.value, roomId)
      ? { kind: 'found' as const, revision: found.record.revision as string | null, value: found.record.value as RoomFence }
      : { kind: 'unavailable' as const };
  }
  async function saveRoom(before: { revision: string | null; value: RoomFence }, next: RoomFence) {
    return settleWrite(guarded, { key: roomKey(next.roomId), expectedRevision: before.revision,
      operationId: writeId([before.revision, next]), next: { value: next as unknown as JsonValue, expiresAt: null } });
  }
  async function readPermit(id: string) {
    const found = await guarded.read<JsonValue>(permitKey(id));
    return found.kind === 'record' && validPermit(found.record.value, id)
      ? { kind: 'found' as const, revision: found.record.revision, value: found.record.value as Permit }
      : { kind: 'unavailable' as const };
  }
  return {
    async acquire(roomId: RoomId, sender: SenderIdentity, clientTxnId: string): Promise<
      | Readonly<{ kind: 'granted'; permitId: string; epoch: number }>
      | Readonly<{ kind: 'held'; epoch: number; operationId: string }>
      | Readonly<{ kind: 'unavailable' }>
    > {
      if (!ID.test(sender.senderId) || !ID.test(sender.deviceId) || !ID.test(clientTxnId)
        || !/^[A-Za-z0-9+/]{43}=?$/u.test(sender.deviceKey)) return { kind: 'unavailable' };
      const id = permitId(roomId, sender.senderId, clientTxnId);
      for (let attempt = 0; attempt < 8; attempt++) {
        const current = await readRoom(roomId);
        if (current.kind !== 'found') return { kind: 'unavailable' };
        const prior = current.value.senders.find(item => item.senderId === sender.senderId);
        if (prior && (prior.deviceId !== sender.deviceId || prior.deviceKey !== sender.deviceKey)) return { kind: 'unavailable' };
        if (current.value.activePermits.includes(id)) {
          const permit = await readPermit(id);
          return permit.kind === 'found' && permit.value.state !== 'complete' && permit.value.senderId === sender.senderId
            ? { kind: 'granted', permitId: id, epoch: current.value.epoch } : { kind: 'unavailable' };
        }
        if (current.value.hold) return { kind: 'held', epoch: current.value.epoch,
          operationId: current.value.hold.operationId };
        if (prior && prior.rotatedEpoch < current.value.epoch) return { kind: 'held', epoch: current.value.epoch,
          operationId: 'rotation_required' };
        if (current.value.activePermits.length >= MAX_ACTIVE || (!prior && current.value.senders.length >= MAX_SENDERS)) {
          return { kind: 'unavailable' };
        }
        const initial: Permit = { v: 1, roomId, senderId: sender.senderId, clientTxnId,
          permitId: id, state: 'active', eventId: null };
        const prepared = await settleWrite(guarded, { key: permitKey(id), expectedRevision: null,
          operationId: writeId(initial), next: { value: initial as unknown as JsonValue, expiresAt: null } });
        if (prepared.kind !== 'applied' && (prepared.kind !== 'conflict' || !prepared.current
          || !validPermit(prepared.current.value, id) || prepared.current.value.state === 'complete')) return { kind: 'unavailable' };
        const next: RoomFence = { ...current.value, revision: current.value.revision + 1,
          senders: prior ? current.value.senders : [...current.value.senders,
            { ...sender, rotatedEpoch: current.value.epoch }],
          activePermits: [...current.value.activePermits, id] };
        const saved = await saveRoom(current, next);
        if (saved.kind === 'applied') return { kind: 'granted', permitId: id, epoch: next.epoch };
        if (saved.kind !== 'conflict') return { kind: 'unavailable' };
      }
      return { kind: 'unavailable' };
    },
    async finish(roomId: RoomId, senderId: string, id: string, outcome: Readonly<{ kind: 'complete'; eventId: string }> | Readonly<{ kind: 'unknown' }>): Promise<'applied' | 'unavailable'> {
      const found = await readPermit(id);
      if (found.kind !== 'found' || found.value.roomId !== roomId || found.value.senderId !== senderId) return 'unavailable';
      const next: Permit = { ...found.value, state: outcome.kind === 'complete' ? 'complete' : 'unknown',
        eventId: outcome.kind === 'complete' ? outcome.eventId : null };
      if (found.value.state === 'complete') return found.value.eventId === next.eventId ? 'applied' : 'unavailable';
      const saved = await settleWrite(guarded, { key: permitKey(id), expectedRevision: found.revision,
        operationId: writeId(next), next: { value: next as unknown as JsonValue, expiresAt: null } });
      return saved.kind === 'applied' || saved.kind === 'conflict' && validPermit(saved.current!.value, id)
        && saved.current!.value.state === next.state && saved.current!.value.eventId === next.eventId ? 'applied' : 'unavailable';
    },
    async beginHold(roomId: RoomId, operationId: string, excludedDeviceKey: string): Promise<'held' | 'unavailable'> {
      if (!ID.test(operationId) || !/^[A-Za-z0-9+/]{43}=?$/u.test(excludedDeviceKey)) return 'unavailable';
      for (let attempt = 0; attempt < 8; attempt++) {
        const current = await readRoom(roomId);
        if (current.kind !== 'found') return 'unavailable';
        if (current.value.hold) return current.value.hold.operationId === operationId
          && current.value.hold.excludedDeviceKey === excludedDeviceKey ? 'held' : 'unavailable';
        const next: RoomFence = { ...current.value, revision: current.value.revision + 1,
          epoch: current.value.epoch + 1, hold: { operationId, excludedDeviceKey, epoch: current.value.epoch + 1 } };
        const saved = await saveRoom(current, next);
        if (saved.kind === 'applied') return 'held';
        if (saved.kind !== 'conflict') return 'unavailable';
      }
      return 'unavailable';
    },
    async drained(roomId: RoomId, operationId: string): Promise<'drained' | 'pending' | 'unavailable'> {
      for (let attempt = 0; attempt < 8; attempt++) {
        const current = await readRoom(roomId);
        if (current.kind !== 'found' || current.value.hold?.operationId !== operationId) return 'unavailable';
        const unsettled: string[] = [];
        for (const id of current.value.activePermits) {
          const found = await readPermit(id);
          if (found.kind !== 'found') return 'unavailable';
          if (found.value.state !== 'complete') unsettled.push(id);
        }
        if (unsettled.length === current.value.activePermits.length) return unsettled.length ? 'pending' : 'drained';
        const next: RoomFence = { ...current.value, revision: current.value.revision + 1, activePermits: unsettled };
        const saved = await saveRoom(current, next);
        if (saved.kind === 'applied') return unsettled.length ? 'pending' : 'drained';
        if (saved.kind !== 'conflict') return 'unavailable';
      }
      return 'unavailable';
    },
    async inspect(roomId: RoomId) { return readRoom(roomId); },
  };
}
