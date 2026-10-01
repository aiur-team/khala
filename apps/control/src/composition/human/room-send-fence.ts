import { createHash } from 'node:crypto';
import type { ControlStore, JsonValue, RoomId } from '@khala/contracts/messaging/index';
import { guardStore, settleWrite } from '../../auth/store';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_SENDERS = 128;
const MAX_ACTIVE = 128;
export type SenderIdentity = Readonly<{ senderId: string; deviceId: string; deviceKey: string }>;
type Sender = SenderIdentity & Readonly<{ rotatedEpoch: number }>;
type Hold = Readonly<{ operationId: string; excludedDeviceKey: string | null; epoch: number }>;
type RoomFence = Readonly<{ v: 1; roomId: RoomId; revision: number; epoch: number; rosterVerified: boolean;
  hold: Hold | null; settled: Readonly<{ operationId: string; kind: 'rotated' | 'refused' }> | null;
  senders: readonly Sender[]; activePermits: readonly string[] }>;
type Permit = Readonly<{ v: 1; roomId: RoomId; senderId: string; clientTxnId: string;
  permitId: string; state: 'active' | 'unknown' | 'complete' | 'cancelled'; eventId: string | null;
  attempt?: number }>;

function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function senderIdFor(matrixUserId: string, deviceId: string): string {
  return `sender_${hash([matrixUserId, deviceId])}`;
}
function roomKey(roomId: RoomId): string { return `room-send-fence.v1.${hash(roomId)}`; }
function permitKey(permitId: string): string { return `room-send-permit.v1.${hash(permitId)}`; }
function permitId(roomId: RoomId, senderId: string, clientTxnId: string): string {
  return `permit_${hash([roomId, senderId, clientTxnId])}`;
}
function writeId(value: unknown): string { return `room-send-fence.${hash(value)}`; }
function validRoom(value: JsonValue, roomId: RoomId): value is RoomFence & JsonValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, JsonValue>;
  return Object.keys(row).sort().join(',') === 'activePermits,epoch,hold,revision,roomId,rosterVerified,senders,settled,v'
    && row.v === 1 && row.roomId === roomId && Number.isSafeInteger(row.revision) && Number.isSafeInteger(row.epoch)
    && typeof row.rosterVerified === 'boolean'
    && Array.isArray(row.activePermits) && row.activePermits.length <= MAX_ACTIVE
    && row.activePermits.every(id => typeof id === 'string' && ID.test(id))
    && Array.isArray(row.senders) && row.senders.length <= MAX_SENDERS
    && row.senders.every(sender => typeof sender === 'object' && sender !== null && !Array.isArray(sender)
      && Object.keys(sender).sort().join(',') === 'deviceId,deviceKey,rotatedEpoch,senderId'
      && typeof sender.senderId === 'string' && ID.test(sender.senderId)
      && typeof sender.deviceId === 'string' && ID.test(sender.deviceId)
      && typeof sender.deviceKey === 'string' && /^[A-Za-z0-9+/]{43}=?$/u.test(sender.deviceKey)
      && Number.isSafeInteger(sender.rotatedEpoch))
    && (row.settled === null || typeof row.settled === 'object' && !Array.isArray(row.settled)
      && typeof (row.settled as Record<string, JsonValue>).operationId === 'string'
      && ID.test(String((row.settled as Record<string, JsonValue>).operationId))
      && ['rotated', 'refused'].includes(String((row.settled as Record<string, JsonValue>).kind)))
    && (row.hold === null || typeof row.hold === 'object' && !Array.isArray(row.hold)
      && typeof (row.hold as Record<string, JsonValue>).operationId === 'string'
      && ID.test(String((row.hold as Record<string, JsonValue>).operationId))
      && ((row.hold as Record<string, JsonValue>).excludedDeviceKey === null
        || typeof (row.hold as Record<string, JsonValue>).excludedDeviceKey === 'string'
          && /^[A-Za-z0-9+/]{43}=?$/u.test(String((row.hold as Record<string, JsonValue>).excludedDeviceKey)))
      && Number.isSafeInteger((row.hold as Record<string, JsonValue>).epoch));
}
function validPermit(value: JsonValue, id: string): value is Permit & JsonValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, JsonValue>;
  return ['attempt,clientTxnId,eventId,permitId,roomId,senderId,state,v',
    'clientTxnId,eventId,permitId,roomId,senderId,state,v'].includes(Object.keys(row).sort().join(','))
    && row.v === 1 && row.permitId === id && typeof row.roomId === 'string'
    && (row.attempt === undefined || Number.isSafeInteger(row.attempt) && (row.attempt as number) >= 0)
    && typeof row.senderId === 'string' && typeof row.clientTxnId === 'string'
    && ['active', 'unknown', 'complete', 'cancelled'].includes(String(row.state))
    && (row.eventId === null || typeof row.eventId === 'string');
}

/** Durable room-wide send barrier. Unknown Matrix outcomes remain active until the same txn settles. */
export function createRoomSendFence(store: ControlStore) {
  const guarded = guardStore(store);
  async function readRoom(roomId: RoomId) {
    const found = await guarded.read<JsonValue>(roomKey(roomId));
    if (found.kind === 'unavailable') return { kind: 'unavailable' as const };
    if (found.kind === 'absent') return { kind: 'found' as const, revision: null as string | null,
      value: { v: 1, roomId, revision: 0, epoch: 0, hold: null, settled: null, rosterVerified: false,
        senders: [], activePermits: [] } as RoomFence };
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
    if (found.kind === 'absent') return { kind: 'absent' as const };
    return found.kind === 'record' && validPermit(found.record.value, id)
      ? { kind: 'found' as const, revision: found.record.revision, value: found.record.value as Permit }
      : { kind: 'unavailable' as const };
  }
  return {
    /** Initial SDK discard before this device's first permitted send on this implementation. */
    async readySender(roomId: RoomId, sender: SenderIdentity): Promise<'applied' | 'held' | 'unavailable'> {
      if (!ID.test(sender.senderId) || !ID.test(sender.deviceId)
        || !/^[A-Za-z0-9+/]{43}=?$/u.test(sender.deviceKey)) return 'unavailable';
      for (let attempt = 0; attempt < 8; attempt++) {
        const current = await readRoom(roomId);
        if (current.kind !== 'found') return 'unavailable';
        if (current.value.hold) return 'held';
        const prior = current.value.senders.find(item => item.senderId === sender.senderId);
        if (prior && (prior.deviceId !== sender.deviceId || prior.deviceKey !== sender.deviceKey)) return 'unavailable';
        if (prior?.rotatedEpoch === current.value.epoch) return 'applied';
        if (!prior && current.value.senders.length >= MAX_SENDERS) return 'unavailable';
        const next: RoomFence = { ...current.value, revision: current.value.revision + 1,
          senders: prior ? current.value.senders.map(item => item.senderId === sender.senderId
            ? { ...item, rotatedEpoch: current.value.epoch } : item)
            : [...current.value.senders, { ...sender, rotatedEpoch: current.value.epoch }] };
        const saved = await saveRoom(current, next);
        if (saved.kind === 'applied') return 'applied';
        if (saved.kind !== 'conflict') return 'unavailable';
      }
      return 'unavailable';
    },
    /** A Matrix roster query must cover every currently published adapter device, including legacy senders. */
    async seedRoster(roomId: RoomId, verifiedSenders: readonly SenderIdentity[]): Promise<'applied' | 'unavailable'> {
      if (verifiedSenders.length > MAX_SENDERS || new Set(verifiedSenders.map(sender => sender.senderId)).size !== verifiedSenders.length
        || verifiedSenders.some(sender => !ID.test(sender.senderId) || !ID.test(sender.deviceId)
          || !/^[A-Za-z0-9+/]{43}=?$/u.test(sender.deviceKey))) return 'unavailable';
      for (let attempt = 0; attempt < 8; attempt++) {
        const current = await readRoom(roomId);
        if (current.kind !== 'found' || current.value.hold) return 'unavailable';
        const priorById = new Map(current.value.senders.map(sender => [sender.senderId, sender]));
        const byId = new Map<string, Sender>();
        for (const sender of verifiedSenders) {
          const prior = priorById.get(sender.senderId);
          if (prior && (prior.deviceId !== sender.deviceId || prior.deviceKey !== sender.deviceKey)) return 'unavailable';
          byId.set(sender.senderId, prior ?? { ...sender, rotatedEpoch: -1 });
        }
        if (byId.size > MAX_SENDERS) return 'unavailable';
        const next: RoomFence = { ...current.value, revision: current.value.revision + 1,
          rosterVerified: true, senders: [...byId.values()] };
        const saved = await saveRoom(current, next);
        if (saved.kind === 'applied') return 'applied';
        if (saved.kind !== 'conflict') return 'unavailable';
      }
      return 'unavailable';
    },
    async acquire(roomId: RoomId, sender: SenderIdentity, clientTxnId: string, reopenCancelled = false): Promise<
      | Readonly<{ kind: 'granted'; permitId: string; epoch: number; attempt: number }>
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
        const listed = current.value.activePermits.includes(id);
        const permit = await readPermit(id);
        if (permit.kind === 'unavailable' || listed && permit.kind === 'absent' || permit.kind === 'found'
          && (permit.value.roomId !== roomId || permit.value.senderId !== sender.senderId
            || permit.value.clientTxnId !== clientTxnId || permit.value.state === 'complete')) return { kind: 'unavailable' };
        if (listed && permit.kind === 'found' && permit.value.state !== 'cancelled') {
          return { kind: 'granted', permitId: id, epoch: current.value.epoch, attempt: permit.value.attempt ?? 0 };
        }
        if (permit.kind === 'found' && permit.value.state === 'cancelled' && !reopenCancelled) return { kind: 'unavailable' };
        if (current.value.hold) return { kind: 'held', epoch: current.value.epoch,
          operationId: current.value.hold.operationId };
        if (!prior || prior.rotatedEpoch < current.value.epoch) return { kind: 'held', epoch: current.value.epoch,
          operationId: 'rotation_required' };
        if (!listed && current.value.activePermits.length >= MAX_ACTIVE
          || !prior && current.value.senders.length >= MAX_SENDERS) {
          return { kind: 'unavailable' };
        }
        const initial: Permit = { v: 1, roomId, senderId: sender.senderId, clientTxnId,
          permitId: id, state: 'active', eventId: null,
          attempt: permit.kind === 'found' ? (permit.value.attempt ?? 0) + 1 : 0 };
        if (permit.kind === 'absent' || permit.value.state === 'cancelled') {
          const prepared = await settleWrite(guarded, { key: permitKey(id),
            expectedRevision: permit.kind === 'absent' ? null : permit.revision,
            operationId: writeId([permit.kind === 'absent' ? null : permit.revision, initial]),
            next: { value: initial as unknown as JsonValue, expiresAt: null } });
          if (prepared.kind === 'conflict') continue;
          if (prepared.kind !== 'applied') return { kind: 'unavailable' };
        }
        const next: RoomFence = { ...current.value, revision: current.value.revision + 1,
          senders: current.value.senders,
          activePermits: listed ? current.value.activePermits : [...current.value.activePermits, id] };
        const saved = await saveRoom(current, next);
        if (saved.kind === 'applied') return { kind: 'granted', permitId: id, epoch: next.epoch, attempt: initial.attempt! };
        if (saved.kind !== 'conflict') return { kind: 'unavailable' };
      }
      return { kind: 'unavailable' };
    },
    async finish(roomId: RoomId, senderId: string, id: string, outcome: Readonly<{ kind: 'complete'; eventId: string }> | Readonly<{ kind: 'unknown' | 'cancelled' }>, attempt = 0): Promise<'applied' | 'unavailable'> {
      const found = await readPermit(id);
      if (found.kind !== 'found' || found.value.roomId !== roomId || found.value.senderId !== senderId
        || (found.value.attempt ?? 0) !== attempt) return 'unavailable';
      const next: Permit = { ...found.value, state: outcome.kind,
        eventId: outcome.kind === 'complete' ? outcome.eventId : null };
      if (found.value.state === 'complete') return found.value.eventId === next.eventId ? 'applied' : 'unavailable';
      if (found.value.state === 'cancelled') return outcome.kind === 'cancelled' ? 'applied' : 'unavailable';
      const saved = await settleWrite(guarded, { key: permitKey(id), expectedRevision: found.revision,
        operationId: writeId([found.revision, next]), next: { value: next as unknown as JsonValue, expiresAt: null } });
      return saved.kind === 'applied' || saved.kind === 'conflict' && validPermit(saved.current!.value, id)
        && (saved.current!.value.attempt ?? 0) === attempt
        && saved.current!.value.state === next.state && saved.current!.value.eventId === next.eventId ? 'applied' : 'unavailable';
    },
    /** A null exclusion means admission: every current sender must rotate. */
    async beginHold(roomId: RoomId, operationId: string, excludedDeviceKey: string | null): Promise<'held' | 'unavailable'> {
      if (!ID.test(operationId) || excludedDeviceKey !== null
        && !/^[A-Za-z0-9+/]{43}=?$/u.test(excludedDeviceKey)) return 'unavailable';
      for (let attempt = 0; attempt < 8; attempt++) {
        const current = await readRoom(roomId);
        if (current.kind !== 'found' || !current.value.rosterVerified
          || excludedDeviceKey === null && current.value.senders.length === 0) return 'unavailable';
        if (current.value.hold) return current.value.hold.operationId === operationId
          && current.value.hold.excludedDeviceKey === excludedDeviceKey ? 'held' : 'unavailable';
        const next: RoomFence = { ...current.value, revision: current.value.revision + 1,
          epoch: current.value.epoch + 1, settled: null,
          hold: { operationId, excludedDeviceKey, epoch: current.value.epoch + 1 } };
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
          if (found.value.state !== 'complete' && found.value.state !== 'cancelled') unsettled.push(id);
        }
        if (unsettled.length === current.value.activePermits.length) return unsettled.length ? 'pending' : 'drained';
        const next: RoomFence = { ...current.value, revision: current.value.revision + 1, activePermits: unsettled };
        const saved = await saveRoom(current, next);
        if (saved.kind === 'applied') return unsettled.length ? 'pending' : 'drained';
        if (saved.kind !== 'conflict') return 'unavailable';
      }
      return 'unavailable';
    },
    /** Receipt after the sender's own trusted SDK forceDiscardSession(roomId) returns. */
    async acknowledgeRotation(roomId: RoomId, sender: SenderIdentity, operationId: string, epoch: number): Promise<'applied' | 'unavailable'> {
      for (let attempt = 0; attempt < 8; attempt++) {
        const current = await readRoom(roomId);
        if (current.kind !== 'found' || current.value.hold?.operationId !== operationId
          || current.value.epoch !== epoch) return 'unavailable';
        const prior = current.value.senders.find(item => item.senderId === sender.senderId);
        if (!prior || prior.deviceId !== sender.deviceId || prior.deviceKey !== sender.deviceKey) return 'unavailable';
        if (prior.rotatedEpoch === epoch) return 'applied';
        const next: RoomFence = { ...current.value, revision: current.value.revision + 1,
          senders: current.value.senders.map(item => item.senderId === sender.senderId
            ? { ...item, rotatedEpoch: epoch } : item) };
        const saved = await saveRoom(current, next);
        if (saved.kind === 'applied') return 'applied';
        if (saved.kind !== 'conflict') return 'unavailable';
      }
      return 'unavailable';
    },
    async rotationStatus(roomId: RoomId, operationId: string): Promise<'rotated' | 'pending' | 'unavailable'> {
      const current = await readRoom(roomId);
      if (current.kind !== 'found' || !current.value.rosterVerified) {
        return 'unavailable';
      }
      if (current.value.settled?.operationId === operationId && current.value.settled.kind === 'rotated') return 'rotated';
      if (current.value.hold?.operationId !== operationId) return 'unavailable';
      return current.value.senders.every(sender => current.value.hold!.excludedDeviceKey !== null
        && sender.deviceKey === current.value.hold!.excludedDeviceKey
        || sender.rotatedEpoch === current.value.epoch) ? 'rotated' : 'pending';
    },
    async releaseHold(roomId: RoomId, operationId: string, kind: 'rotated' | 'refused'): Promise<'applied' | 'unavailable'> {
      for (let attempt = 0; attempt < 8; attempt++) {
        const current = await readRoom(roomId);
        if (current.kind !== 'found') return 'unavailable';
        if (!current.value.hold) return current.value.settled?.operationId === operationId
          && current.value.settled.kind === kind ? 'applied' : 'unavailable';
        if (current.value.hold.operationId !== operationId) return 'unavailable';
        if (kind === 'rotated' && await this.rotationStatus(roomId, operationId) !== 'rotated') return 'unavailable';
        // A refused replacement can resume the old sessions only before any
        // sender has rotated toward the new device. The CAS below also closes
        // a race with a concurrent rotation receipt.
        if (kind === 'refused' && current.value.hold.excludedDeviceKey === null
          && current.value.senders.some(sender => sender.rotatedEpoch === current.value.epoch)) return 'unavailable';
        const next: RoomFence = { ...current.value, revision: current.value.revision + 1,
          hold: null, settled: { operationId, kind },
          senders: kind === 'refused' ? current.value.senders.map(sender => ({ ...sender, rotatedEpoch: current.value.epoch }))
            : current.value.senders };
        const saved = await saveRoom(current, next);
        if (saved.kind === 'applied') return 'applied';
        if (saved.kind !== 'conflict') return 'unavailable';
      }
      return 'unavailable';
    },
    async inspect(roomId: RoomId) { return readRoom(roomId); },
  };
}
