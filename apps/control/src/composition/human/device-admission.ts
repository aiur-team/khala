import { createHash } from 'node:crypto';
import type { ControlStore, EventId, JsonValue, OwnerId, RoomId } from '@khala/contracts/messaging/index';
import { guardStore, settleWrite } from '../../auth/store';
import { createRoomSendFence } from './room-send-fence';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const KEY = /^[A-Za-z0-9+/]{43}=?$/u;
const MAX_DEVICES = 128;
type Device = Readonly<{ ownerId: OwnerId; deviceId: string; deviceKey: string; generation: number;
  policyDigest: string; operationId: string; cutoff: number; state: 'pending' | 'activating' | 'active' | 'revoked' }>;
type RoomRecord = Readonly<{ v: 1; roomId: RoomId; devices: readonly Device[] }>;
export type Replacement = Readonly<{ roomId: RoomId; ownerId: OwnerId; deviceId: string; deviceKey: string;
  generation: number; policyDigest: string; operationId: string }>;
export type DeviceRead = Readonly<{ roomId: RoomId; ownerId: OwnerId; deviceId: string;
  deviceKey: string; generation: number; eventId: EventId }>;
type Result = 'applied' | 'pending' | 'conflict' | 'refused' | 'unavailable';

function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function key(roomId: RoomId): string { return `device-admission.v1.${hash(roomId)}`; }
function operationKey(operationId: string): string { return `device-admission-operation.v1.${hash(operationId)}`; }
function validDevice(value: JsonValue): value is Device & JsonValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, JsonValue>;
  return Object.keys(row).sort().join(',') === 'cutoff,deviceId,deviceKey,generation,operationId,ownerId,policyDigest,state'
    && typeof row.ownerId === 'string' && ID.test(row.ownerId)
    && typeof row.deviceId === 'string' && ID.test(row.deviceId)
    && typeof row.deviceKey === 'string' && KEY.test(row.deviceKey)
    && Number.isSafeInteger(row.generation) && (row.generation as number) >= 0
    && typeof row.policyDigest === 'string' && /^[a-f0-9]{64}$/u.test(row.policyDigest)
    && typeof row.operationId === 'string' && ID.test(row.operationId)
    && Number.isSafeInteger(row.cutoff) && (row.cutoff as number) >= 0
    && ['pending', 'activating', 'active', 'revoked'].includes(String(row.state));
}
function validRoom(value: JsonValue, roomId: RoomId): value is RoomRecord & JsonValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, JsonValue>;
  return Object.keys(row).sort().join(',') === 'devices,roomId,v' && row.v === 1 && row.roomId === roomId
    && Array.isArray(row.devices) && row.devices.length <= MAX_DEVICES && row.devices.every(validDevice)
    && new Set(row.devices.map(device => (device as Device).operationId)).size === row.devices.length
    && new Set(row.devices.map(device => JSON.stringify([(device as Device).ownerId, (device as Device).deviceId]))).size === row.devices.length;
}
function valid(input: Replacement): boolean {
  return ID.test(input.ownerId) && ID.test(input.deviceId) && KEY.test(input.deviceKey)
    && ID.test(input.operationId) && /^[a-f0-9]{64}$/u.test(input.policyDigest)
    && Number.isSafeInteger(input.generation) && input.generation >= 0;
}
function same(a: Device, b: Replacement): boolean {
  return a.ownerId === b.ownerId && a.deviceId === b.deviceId && a.deviceKey === b.deviceKey
    && a.generation === b.generation && a.policyDigest === b.policyDigest && a.operationId === b.operationId;
}

/**
 * Server-side exact-device cutoff. The injected authority owns the unresolved
 * G-ADMISSION interaction; an unavailable/refused verdict never creates access.
 * The cutoff source must be the trusted room event stream, never browser input.
 */
export function createDeviceAdmission(input: Readonly<{
  store: ControlStore;
  authorize(request: Replacement): Promise<'authorized' | 'refused' | 'unavailable'>;
  currentPosition(roomId: RoomId): Promise<number | null>;
  /** Resolve a Matrix event to a trusted per-room order; never use browser metadata. */
  positionFor(roomId: RoomId, eventId: EventId): Promise<number | null>;
  distributionReady(request: Replacement): Promise<boolean>;
}>) {
  const store = guardStore(input.store);
  const fence = createRoomSendFence(input.store);
  async function read(roomId: RoomId) {
    const found = await store.read<JsonValue>(key(roomId));
    if (found.kind === 'unavailable') return { kind: 'unavailable' as const };
    if (found.kind === 'absent') return { kind: 'found' as const, revision: null as string | null,
      value: { v: 1, roomId, devices: [] } as RoomRecord };
    return validRoom(found.record.value, roomId)
      ? { kind: 'found' as const, revision: found.record.revision as string | null, value: found.record.value as RoomRecord }
      : { kind: 'unavailable' as const };
  }
  async function save(before: { revision: string | null; value: RoomRecord }, next: RoomRecord) {
    return settleWrite(store, { key: key(next.roomId), expectedRevision: before.revision,
      operationId: `device-admission.${hash([before.revision, next])}`,
      next: { value: next as unknown as JsonValue, expiresAt: null } });
  }
  async function claimOperation(request: Replacement): Promise<'applied' | 'conflict' | 'unavailable'> {
    const claimKey = operationKey(request.operationId);
    const matches = (prior: JsonValue): boolean => {
      if (typeof prior !== 'object' || prior === null || Array.isArray(prior)) return false;
      const row = prior as Record<string, JsonValue>;
      return Object.keys(row).sort().join(',') === 'deviceId,deviceKey,generation,operationId,ownerId,policyDigest,roomId'
        && row.roomId === request.roomId && row.ownerId === request.ownerId && row.deviceId === request.deviceId
        && row.deviceKey === request.deviceKey && row.generation === request.generation
        && row.policyDigest === request.policyDigest && row.operationId === request.operationId;
    };
    const existing = await store.read<JsonValue>(claimKey);
    if (existing.kind === 'unavailable') return 'unavailable';
    if (existing.kind === 'record') return matches(existing.record.value) ? 'applied' : 'conflict';
    const claim = { ...request } as unknown as JsonValue;
    const saved = await settleWrite(store, { key: claimKey, expectedRevision: null,
      operationId: `device-admission.claim.${hash(request.operationId)}`,
      next: { value: claim, expiresAt: null } });
    if (saved.kind === 'applied') return 'applied';
    if (saved.kind === 'conflict' && saved.current) return matches(saved.current.value) ? 'applied' : 'conflict';
    const after = await store.read<JsonValue>(claimKey);
    return after.kind === 'record' ? matches(after.record.value) ? 'applied' : 'conflict' : 'unavailable';
  }
  async function releaseCancelled(request: Replacement): Promise<Result> {
    const current = await fence.inspect(request.roomId);
    if (current.kind !== 'found') return 'unavailable';
    if (current.value.hold === null) return current.value.settled?.operationId === request.operationId
      && current.value.settled.kind === 'refused' ? 'applied' : 'unavailable';
    if (current.value.hold.operationId !== request.operationId
      || current.value.hold.excludedDeviceKey !== null) return 'unavailable';
    if (current.value.senders.some(sender => sender.rotatedEpoch === current.value.epoch)) return 'pending';
    return await fence.releaseHold(request.roomId, request.operationId, 'refused') === 'applied'
      ? 'applied' : 'pending';
  }
  return {
    async reserve(request: Replacement): Promise<Result> {
      if (!valid(request)) return 'refused';
      const authority = await input.authorize(request).catch(() => 'unavailable' as const);
      if (authority !== 'authorized') return authority;
      const claim = await claimOperation(request);
      if (claim !== 'applied') return claim;
      for (let attempt = 0; attempt < 8; attempt++) {
        const current = await read(request.roomId);
        if (current.kind !== 'found') return 'unavailable';
        const operation = current.value.devices.find(device => device.operationId === request.operationId);
        if (operation) return same(operation, request) && operation.state !== 'revoked'
          ? operation.state === 'active' ? 'applied' : 'pending' : 'conflict';
        if (current.value.devices.some(device => device.ownerId === request.ownerId && device.deviceId === request.deviceId)
          || current.value.devices.length >= MAX_DEVICES) return 'conflict';
        if (await fence.beginHold(request.roomId, request.operationId, null) !== 'held') return 'unavailable';
        if (await fence.drained(request.roomId, request.operationId) !== 'drained') return 'pending';
        const cutoff = await input.currentPosition(request.roomId).catch(() => null);
        if (cutoff === null || !Number.isSafeInteger(cutoff) || cutoff < 0) return 'unavailable';
        const { ownerId, deviceId, deviceKey, generation, policyDigest, operationId } = request;
        const device: Device = { ownerId, deviceId, deviceKey, generation, policyDigest, operationId,
          cutoff, state: 'pending' };
        const saved = await save(current, { ...current.value, devices: [...current.value.devices, device] });
        if (saved.kind === 'applied') return 'pending';
        if (saved.kind !== 'conflict') return 'unavailable';
      }
      return 'unavailable';
    },
    async activate(request: Replacement): Promise<Result> {
      if (!valid(request)) return 'refused';
      const authority = await input.authorize(request).catch(() => 'unavailable' as const);
      if (authority !== 'authorized') return authority;
      if (await fence.rotationStatus(request.roomId, request.operationId) !== 'rotated'
        || !await input.distributionReady(request).catch(() => false)) return 'pending';
      for (let attempt = 0; attempt < 8; attempt++) {
        const current = await read(request.roomId);
        if (current.kind !== 'found') return 'unavailable';
        const device = current.value.devices.find(item => item.operationId === request.operationId);
        if (!device || !same(device, request) || device.state === 'revoked') return 'conflict';
        if (device.state === 'active') return 'applied';
        if (device.state === 'pending') {
          const next = { ...current.value, devices: current.value.devices.map(item => item === device
            ? { ...item, state: 'activating' as const } : item) };
          const saved = await save(current, next);
          if (saved.kind === 'conflict') continue;
          if (saved.kind !== 'applied') return 'unavailable';
        }
        if (await fence.releaseHold(request.roomId, request.operationId, 'rotated') !== 'applied') return 'pending';
        const afterRelease = await read(request.roomId);
        if (afterRelease.kind !== 'found') return 'unavailable';
        const releasing = afterRelease.value.devices.find(item => item.operationId === request.operationId);
        if (!releasing || !same(releasing, request) || releasing.state !== 'activating') return 'conflict';
        const active = { ...afterRelease.value, devices: afterRelease.value.devices.map(item => item === releasing
          ? { ...item, state: 'active' as const } : item) };
        const saved = await save(afterRelease, active);
        if (saved.kind === 'applied') return 'applied';
        if (saved.kind !== 'conflict') return 'unavailable';
      }
      return 'unavailable';
    },
    /** Cancels a pending reservation; partial rotation stays fenced for protocol cleanup. */
    async revoke(request: Replacement): Promise<Result> {
      if (!valid(request)) return 'refused';
      const authority = await input.authorize(request).catch(() => 'unavailable' as const);
      if (authority !== 'authorized') return authority;
      for (let attempt = 0; attempt < 8; attempt++) {
        const current = await read(request.roomId);
        if (current.kind !== 'found') return 'unavailable';
        const device = current.value.devices.find(item => item.operationId === request.operationId);
        if (!device || !same(device, request)) return 'conflict';
        if (device.state === 'revoked') return releaseCancelled(request);
        if (device.state !== 'pending') return 'refused';
        const next = { ...current.value, devices: current.value.devices.map(item => item === device
          ? { ...item, state: 'revoked' as const } : item) };
        const saved = await save(current, next);
        if (saved.kind === 'applied') return releaseCancelled(request);
        if (saved.kind !== 'conflict') return 'unavailable';
      }
      return 'unavailable';
    },
    /** Use for every replacement-device plaintext/key/timeline read. */
    async allows(readRequest: DeviceRead): Promise<boolean> {
      const current = await read(readRequest.roomId);
      if (current.kind !== 'found') return false;
      const active = current.value.devices.find(device => device.state === 'active'
        && device.ownerId === readRequest.ownerId && device.deviceId === readRequest.deviceId
        && device.deviceKey === readRequest.deviceKey && device.generation === readRequest.generation);
      if (!active) return false;
      const position = await input.positionFor(readRequest.roomId, readRequest.eventId).catch(() => null);
      if (position === null || !Number.isSafeInteger(position) || position <= active.cutoff) return false;
      // An active admission is not enough during a later room-wide rotation or
      // when the verified roster has acquired a sender that has not rotated.
      const room = await fence.inspect(readRequest.roomId);
      return room.kind === 'found' && room.value.rosterVerified && room.value.hold === null
        && room.value.senders.length > 0
        && room.value.senders.every(sender => sender.rotatedEpoch === room.value.epoch);
    },
    inspect: read,
  };
}
