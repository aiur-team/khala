import { createHash } from 'node:crypto';
import {
  type BindingId, type ControlStore, type JsonValue, type OwnerId, type ParticipantId, type RoomId,
  type SessionBinding, decodeSessionBinding, sameJsonValue, sameSessionBinding,
} from '@khala/contracts/messaging/index';
import { guardStore, settleWrite } from '../auth/store';

export type BindingRecord = Readonly<{
  binding: SessionBinding;
  revokedGeneration: number | null;
  capability: string | null;
}>;

export type BindingAddress = Readonly<{
  ownerId: OwnerId;
  roomId: RoomId;
  agentParticipantId: ParticipantId;
}>;

export type BindingLookup =
  | Readonly<{ kind: 'found'; record: BindingRecord }>
  | Readonly<{ kind: 'absent' | 'unavailable' }>;

export type SessionClaim =
  | Readonly<{ kind: 'claimed' }>
  | Readonly<{ kind: 'conflict'; agentParticipantId: ParticipantId }>
  | Readonly<{ kind: 'unavailable' }>;

type ParticipantClaimInput = BindingAddress & Readonly<{
  harness: string;
  sessionId: string;
  deviceId: SessionBinding['deviceId'];
  generation: number;
}>;

export type BindingWrite =
  | Readonly<{ kind: 'applied'; record: BindingRecord }>
  | Readonly<{ kind: 'conflict'; record: BindingRecord | null }>
  | Readonly<{ kind: 'unavailable' }>;

export type BindingMutation = 'applied' | 'unchanged' | 'absent' | 'unavailable';

type LocatedBinding =
  | Readonly<{ kind: 'found'; record: BindingRecord; address: BindingAddress }>
  | Readonly<{ kind: 'absent' | 'unavailable' }>;

export type AgentBindingStore = Readonly<{
  findParticipant(address: BindingAddress): Promise<BindingLookup>;
  claimSession(input: ParticipantClaimInput): Promise<SessionClaim>;
  putParticipant(input: BindingAddress & Readonly<{ expectedBindingId: BindingId | null; record: BindingRecord }>): Promise<BindingWrite>;
  findBinding(bindingId: BindingId | string): Promise<BindingLookup>;
  updateBinding(bindingId: BindingId | string, change: (record: BindingRecord) => BindingRecord | null): Promise<BindingMutation>;
}>;

type Forward = Readonly<{ v: 1; kind: 'binding_forward'; agentParticipantId: ParticipantId }>;
type BindingIndex = Readonly<{ v: 1; ownerId: OwnerId; roomId: RoomId; agentParticipantId: ParticipantId }>;
type LegacyBindingIndex = Readonly<{ ownerId: OwnerId; roomId: RoomId }>;
type SessionLocator = Readonly<{
  v: 1; ownerId: OwnerId; roomId: RoomId; harness: string; sessionId: string; agentParticipantId: ParticipantId;
}>;
type PendingBinding = Readonly<{
  v: 1;
  kind: 'binding_pending';
  ownerId: OwnerId;
  roomId: RoomId;
  agentParticipantId: ParticipantId;
  harness: string;
  sessionId: string;
  deviceId: SessionBinding['deviceId'];
  generation: number;
}>;

const CAPABILITY_DIGEST = /^[A-Za-z0-9_-]{43}$/;
const MAX_ATTEMPTS = 8;

/** Stable hashed keys; exported so migration fixtures and deployment probes can seed legacy state without duplicating derivation. */
export const agentBindingStoreKeys = {
  legacy: (ownerId: OwnerId | string, roomId: RoomId | string) => key('binding', [ownerId, roomId]),
  participant: (ownerId: OwnerId | string, roomId: RoomId | string, participantId: ParticipantId | string) =>
    key('binding', [ownerId, roomId, participantId]),
  index: (bindingId: BindingId | string) => key('binding-index', bindingId),
  session: (ownerId: OwnerId | string, roomId: RoomId | string, harness: string, sessionId: string) =>
    key('binding-session', [ownerId, roomId, harness, sessionId]),
} as const;

export function createAgentBindingStore(deps: Readonly<{
  store: ControlStore;
  /** Roll-forward gate. Marker-aware reads are always enabled; omitted means no marker writes. */
  legacyMigrationWritesEnabled?: boolean;
}>): AgentBindingStore {
  const store = guardStore(deps.store);
  const migrationEnabled = deps.legacyMigrationWritesEnabled === true;

  const readJson = (storeKey: string) => store.read<JsonValue>(storeKey);

  async function ensureIndex(address: BindingAddress, bindingId: BindingId): Promise<boolean> {
    const storeKey = agentBindingStoreKeys.index(bindingId);
    const desired: BindingIndex = { v: 1, ...address };
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const read = await readJson(storeKey);
      if (read.kind === 'unavailable') return false;
      if (read.kind === 'record') {
        const current = decodeIndex(read.record.value);
        if (!current || current.ownerId !== address.ownerId || current.roomId !== address.roomId) return false;
        if ('v' in current && current.agentParticipantId !== address.agentParticipantId) return false;
        if ('v' in current) return true;
        const upgraded = await write(storeKey, read.record.revision, desired);
        if (upgraded.kind === 'applied') return true;
        if (upgraded.kind !== 'conflict') return false;
        continue;
      }
      const created = await write(storeKey, null, desired);
      if (created.kind === 'applied') return true;
      if (created.kind !== 'conflict') return false;
    }
    return false;
  }

  async function readScoped(address: BindingAddress, repairIndex = true): Promise<BindingLookup> {
    const read = await readJson(agentBindingStoreKeys.participant(address.ownerId, address.roomId, address.agentParticipantId));
    if (read.kind !== 'record') return read.kind === 'absent' ? { kind: 'absent' } : { kind: 'unavailable' };
    const pending = decodePendingBinding(read.record.value);
    if (pending && pendingMatchesAddress(pending, address)) return { kind: 'absent' };
    const record = decodeBindingRecord(read.record.value);
    if (!record || !bindingMatchesAddress(record, address)) return { kind: 'unavailable' };
    if (repairIndex && !await ensureIndex(address, record.binding.bindingId)) return { kind: 'unavailable' };
    return { kind: 'found', record };
  }

  async function followForward(
    ownerId: OwnerId, roomId: RoomId, forward: Forward, repairIndex = true,
  ): Promise<BindingLookup> {
    const address = { ownerId, roomId, agentParticipantId: forward.agentParticipantId };
    const target = await readScoped(address, repairIndex);
    return target.kind === 'absent' ? { kind: 'unavailable' } : target;
  }

  async function copyLegacy(address: BindingAddress, authoritative: BindingRecord): Promise<boolean> {
    const storeKey = agentBindingStoreKeys.participant(address.ownerId, address.roomId, address.agentParticipantId);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const read = await readJson(storeKey);
      if (read.kind === 'unavailable') return false;
      if (read.kind === 'record') {
        const current = decodeBindingRecord(read.record.value);
        if (!current || !bindingMatchesAddress(current, address) || current.binding.bindingId !== authoritative.binding.bindingId) return false;
        if (sameJsonValue(asJson(current), asJson(authoritative))) return true;
        const recopied = await write(storeKey, read.record.revision, authoritative);
        if (recopied.kind === 'applied') return true;
        if (recopied.kind !== 'conflict') return false;
        continue;
      }
      const copied = await write(storeKey, null, authoritative);
      if (copied.kind === 'applied') return true;
      if (copied.kind !== 'conflict') return false;
    }
    return false;
  }

  async function claimLocator(input: BindingAddress & Readonly<{ harness: string; sessionId: string }>): Promise<SessionClaim> {
    const storeKey = agentBindingStoreKeys.session(input.ownerId, input.roomId, input.harness, input.sessionId);
    const desired: SessionLocator = {
      v: 1, ownerId: input.ownerId, roomId: input.roomId, harness: input.harness,
      sessionId: input.sessionId, agentParticipantId: input.agentParticipantId,
    };
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const read = await readJson(storeKey);
      if (read.kind === 'unavailable') return { kind: 'unavailable' };
      if (read.kind === 'record') {
        const current = decodeSessionLocator(read.record.value);
        if (!current || current.ownerId !== input.ownerId || current.roomId !== input.roomId
          || current.harness !== input.harness || current.sessionId !== input.sessionId) return { kind: 'unavailable' };
        return current.agentParticipantId === input.agentParticipantId
          ? { kind: 'claimed' }
          : { kind: 'conflict', agentParticipantId: current.agentParticipantId };
      }
      const claimed = await write(storeKey, null, desired);
      if (claimed.kind === 'applied') return { kind: 'claimed' };
      if (claimed.kind !== 'conflict') return { kind: 'unavailable' };
    }
    return { kind: 'unavailable' };
  }

  async function migrate(address: BindingAddress): Promise<BindingLookup> {
    const legacyKey = agentBindingStoreKeys.legacy(address.ownerId, address.roomId);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const read = await readJson(legacyKey);
      if (read.kind === 'unavailable') return { kind: 'unavailable' };
      if (read.kind === 'absent') return readScoped(address);
      const forward = decodeForward(read.record.value);
      if (forward) return followForward(address.ownerId, address.roomId, forward);
      const legacy = decodeBindingRecord(read.record.value);
      if (!legacy || legacy.binding.ownerId !== address.ownerId || legacy.binding.agentParticipantId !== address.agentParticipantId) {
        return { kind: 'unavailable' };
      }
      if (!await copyLegacy(address, legacy)) return { kind: 'unavailable' };
      const claimed = await claimLocator({
        ...address, harness: legacy.binding.harness, sessionId: legacy.binding.sessionId,
      });
      if (claimed.kind !== 'claimed') return { kind: 'unavailable' };
      const marker: Forward = {
        v: 1, kind: 'binding_forward', agentParticipantId: address.agentParticipantId,
      };
      const forwarded = await write(legacyKey, read.record.revision, marker);
      if (forwarded.kind === 'conflict') continue;
      if (forwarded.kind !== 'applied' || !await ensureIndex(address, legacy.binding.bindingId)) return { kind: 'unavailable' };
      return readScoped(address);
    }
    return { kind: 'unavailable' };
  }

  async function resolveParticipant(
    address: BindingAddress, legacy: Awaited<ReturnType<typeof readJson>>, repairIndex = true,
  ): Promise<BindingLookup> {
    if (legacy.kind === 'unavailable') return { kind: 'unavailable' };
    if (legacy.kind === 'record') {
      const forward = decodeForward(legacy.record.value);
      if (forward) {
        const target = await followForward(address.ownerId, address.roomId, forward, repairIndex);
        if (target.kind !== 'found') return { kind: 'unavailable' };
        return forward.agentParticipantId === address.agentParticipantId ? target : readScoped(address, repairIndex);
      }
      const record = decodeBindingRecord(legacy.record.value);
      if (!record || record.binding.ownerId !== address.ownerId) return { kind: 'unavailable' };
      if (record.binding.agentParticipantId === address.agentParticipantId) {
        if (!migrationEnabled) return { kind: 'found', record };
        return migrate(address);
      }
    }
    return readScoped(address, repairIndex);
  }

  async function findParticipant(address: BindingAddress, repairIndex = true): Promise<BindingLookup> {
    const legacy = await readJson(agentBindingStoreKeys.legacy(address.ownerId, address.roomId));
    return resolveParticipant(address, legacy, repairIndex);
  }

  async function claimParticipant(input: ParticipantClaimInput): Promise<SessionClaim> {
    const storeKey = agentBindingStoreKeys.participant(input.ownerId, input.roomId, input.agentParticipantId);
    const desired: PendingBinding = { v: 1, kind: 'binding_pending', ...input };
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const read = await readJson(storeKey);
      if (read.kind === 'unavailable') return { kind: 'unavailable' };
      if (read.kind === 'record') {
        const pending = decodePendingBinding(read.record.value);
        if (pending) {
          if (!pendingMatchesAddress(pending, input)) return { kind: 'unavailable' };
          return samePendingIdentity(pending, desired)
            ? { kind: 'claimed' }
            : { kind: 'conflict', agentParticipantId: input.agentParticipantId };
        }
        const current = decodeBindingRecord(read.record.value);
        return current && bindingMatchesAddress(current, input)
          ? { kind: 'claimed' }
          : { kind: 'unavailable' };
      }
      const claimed = await write(storeKey, null, desired);
      if (claimed.kind === 'applied') return { kind: 'claimed' };
      if (claimed.kind !== 'conflict') return { kind: 'unavailable' };
    }
    return { kind: 'unavailable' };
  }

  async function claimSession(input: ParticipantClaimInput): Promise<SessionClaim> {
    const legacy = await readJson(agentBindingStoreKeys.legacy(input.ownerId, input.roomId));
    if (legacy.kind === 'unavailable') return { kind: 'unavailable' };
    let existing: BindingLookup;
    if (legacy.kind === 'record') {
      const forward = decodeForward(legacy.record.value);
      const held = forward
        ? await followForward(input.ownerId, input.roomId, forward)
        : (() => {
            const record = decodeBindingRecord(legacy.record.value);
            return record && record.binding.ownerId === input.ownerId ? { kind: 'found' as const, record } : { kind: 'unavailable' as const };
          })();
      if (held.kind !== 'found') return { kind: 'unavailable' };
      if (held.record.binding.harness === input.harness && held.record.binding.sessionId === input.sessionId
        && held.record.binding.agentParticipantId !== input.agentParticipantId) {
        return { kind: 'conflict', agentParticipantId: held.record.binding.agentParticipantId };
      }
      existing = held.record.binding.agentParticipantId === input.agentParticipantId
        ? held
        : await readScoped(input);
    } else existing = await readScoped(input);
    if (existing.kind === 'unavailable') return { kind: 'unavailable' };
    if (existing.kind === 'found' && (existing.record.binding.harness !== input.harness || existing.record.binding.sessionId !== input.sessionId)) {
      return { kind: 'conflict', agentParticipantId: input.agentParticipantId };
    }
    const located = await claimLocator(input);
    if (located.kind !== 'claimed') return located;
    return existing.kind === 'found' ? located : claimParticipant(input);
  }

  async function putParticipant(
    input: BindingAddress & Readonly<{ expectedBindingId: BindingId | null; record: BindingRecord }>,
  ): Promise<BindingWrite> {
    const decodedInput = decodeBindingRecord(input.record);
    if (!decodedInput || !sameJsonValue(asJson(decodedInput), asJson(input.record)) || !bindingMatchesAddress(decodedInput, input)) {
      return { kind: 'unavailable' };
    }
    const claim = await claimSession({
      ownerId: input.ownerId, roomId: input.roomId, agentParticipantId: input.agentParticipantId,
      harness: input.record.binding.harness, sessionId: input.record.binding.sessionId,
      deviceId: input.record.binding.deviceId, generation: input.record.binding.generation,
    });
    if (claim.kind === 'conflict') return { kind: 'conflict', record: null };
    if (claim.kind === 'unavailable') return { kind: 'unavailable' };
    const storeKey = agentBindingStoreKeys.participant(input.ownerId, input.roomId, input.agentParticipantId);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const current = await findParticipant(input);
      if (current.kind === 'unavailable') return { kind: 'unavailable' };
      if (current.kind === 'found') {
        if (sameJsonValue(asJson(current.record), asJson(input.record))) return { kind: 'applied', record: current.record };
        if (input.expectedBindingId === null || current.record.binding.bindingId !== input.expectedBindingId) {
          return { kind: 'conflict', record: current.record };
        }
        if (!validReplacement(current.record, input.record)) return { kind: 'conflict', record: current.record };
      } else if (input.expectedBindingId !== null) return { kind: 'conflict', record: null };

      if (!migrationEnabled && current.kind === 'found') {
        const legacyKey = agentBindingStoreKeys.legacy(input.ownerId, input.roomId);
        const legacy = await readJson(legacyKey);
        if (legacy.kind === 'unavailable') return { kind: 'unavailable' };
        if (legacy.kind === 'record') {
          const decoded = decodeBindingRecord(legacy.record.value);
          if (decoded?.binding.bindingId === current.record.binding.bindingId && bindingMatchesAddress(decoded, input)) {
            const replaced = await write(legacyKey, legacy.record.revision, input.record);
            if (replaced.kind === 'conflict') continue;
            const address: BindingAddress = {
              ownerId: input.ownerId, roomId: input.roomId, agentParticipantId: input.agentParticipantId,
            };
            if (replaced.kind !== 'applied' || !await ensureIndex(address, input.record.binding.bindingId)) {
              return { kind: 'unavailable' };
            }
            return { kind: 'applied', record: input.record };
          }
        }
      }

      const scoped = await readJson(storeKey);
      if (scoped.kind === 'unavailable') return { kind: 'unavailable' };
      const expectedRevision = scoped.kind === 'record' ? scoped.record.revision : null;
      if (scoped.kind === 'record') {
        const decoded = decodeBindingRecord(scoped.record.value);
        const pending = decodePendingBinding(scoped.record.value);
        const finalizingClaim = current.kind === 'absent' && input.expectedBindingId === null
          && pending !== null && pendingMatchesRecord(pending, input.record);
        if (!finalizingClaim && (!decoded || !bindingMatchesAddress(decoded, input)
          || (current.kind === 'found' && decoded.binding.bindingId !== current.record.binding.bindingId))) return { kind: 'unavailable' };
      }
      const written = await write(storeKey, expectedRevision, input.record);
      if (written.kind === 'conflict') continue;
      const address: BindingAddress = {
        ownerId: input.ownerId, roomId: input.roomId, agentParticipantId: input.agentParticipantId,
      };
      if (written.kind !== 'applied' || !await ensureIndex(address, input.record.binding.bindingId)) return { kind: 'unavailable' };
      return { kind: 'applied', record: input.record };
    }
    return { kind: 'unavailable' };
  }

  async function locateBinding(bindingId: BindingId | string): Promise<LocatedBinding> {
    const index = await readJson(agentBindingStoreKeys.index(bindingId));
    if (index.kind === 'unavailable') return { kind: 'unavailable' };
    if (index.kind === 'absent') return { kind: 'absent' };
    const decoded = decodeIndex(index.record.value);
    if (!decoded) return { kind: 'unavailable' };
    let address: BindingAddress;
    const modernIndex = 'v' in decoded;
    if (modernIndex) address = decoded;
    else {
      const legacy = await readJson(agentBindingStoreKeys.legacy(decoded.ownerId, decoded.roomId));
      if (legacy.kind !== 'record') return { kind: 'unavailable' };
      const forward = decodeForward(legacy.record.value);
      const record = forward ? null : decodeBindingRecord(legacy.record.value);
      const participant = forward?.agentParticipantId ?? record?.binding.agentParticipantId;
      if (!participant) return { kind: 'unavailable' };
      address = { ...decoded, agentParticipantId: participant };
    }
    const found = await findParticipant(address, !modernIndex);
    if (found.kind === 'absent') return { kind: 'unavailable' };
    if (found.kind !== 'found') return found;
    if (found.record.binding.bindingId !== bindingId) return { kind: 'absent' };
    return { ...found, address };
  }

  async function findBinding(bindingId: BindingId | string): Promise<BindingLookup> {
    const located = await locateBinding(bindingId);
    return located.kind === 'found' ? { kind: 'found', record: located.record } : located;
  }

  async function updateBinding(
    bindingId: BindingId | string, change: (record: BindingRecord) => BindingRecord | null,
  ): Promise<BindingMutation> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const found = await locateBinding(bindingId);
      if (found.kind !== 'found') return found.kind;
      const next = change(found.record);
      if (next === null) return 'unchanged';
      const decodedNext = decodeBindingRecord(next);
      if (!decodedNext || !sameJsonValue(asJson(decodedNext), asJson(next)) || !sameSessionBinding(next.binding, found.record.binding)
        || next.binding.bindingId !== bindingId) return 'unavailable';
      const { address } = found;
      const legacyKey = agentBindingStoreKeys.legacy(address.ownerId, address.roomId);
      const legacy = await readJson(legacyKey);
      if (legacy.kind === 'unavailable') return 'unavailable';
      let storeKey = agentBindingStoreKeys.participant(address.ownerId, address.roomId, address.agentParticipantId);
      let read: Awaited<ReturnType<typeof readJson>>;
      if (!migrationEnabled && legacy.kind === 'record' && decodeBindingRecord(legacy.record.value)?.binding.bindingId === bindingId) {
        storeKey = legacyKey;
        read = legacy;
      } else read = await readJson(storeKey);
      if (read.kind !== 'record') return 'unavailable';
      const current = decodeBindingRecord(read.record.value);
      if (!current || current.binding.bindingId !== bindingId) continue;
      const written = await write(storeKey, read.record.revision, next);
      if (written.kind === 'applied') return 'applied';
      if (written.kind !== 'conflict') return 'unavailable';
    }
    return 'unavailable';
  }

  async function write(storeKey: string, expectedRevision: string | null, value: object) {
    const json = asJson(value);
    return settleWrite<JsonValue>(store, {
      key: storeKey, expectedRevision, operationId: operationId(storeKey, expectedRevision, json), next: { value: json, expiresAt: null },
    });
  }

  return { findParticipant, claimSession, putParticipant, findBinding, updateBinding };
}

function decodeBindingRecord(value: unknown): BindingRecord | null {
  const object = exactObject(value, ['binding', 'revokedGeneration', 'capability']);
  if (!object) return null;
  const binding = decodeSessionBinding(object.binding);
  if (!binding.ok) return null;
  const revokedGeneration = object.revokedGeneration;
  if (revokedGeneration !== null && (!Number.isSafeInteger(revokedGeneration) || (revokedGeneration as number) < 0)) return null;
  const capability = object.capability;
  if (capability !== null && (typeof capability !== 'string' || !CAPABILITY_DIGEST.test(capability))) return null;
  return { binding: binding.value, revokedGeneration: revokedGeneration as number | null, capability };
}

function decodeForward(value: unknown): Forward | null {
  const object = exactObject(value, ['v', 'kind', 'agentParticipantId']);
  if (!object || object.v !== 1 || object.kind !== 'binding_forward'
    || !identifier(object.agentParticipantId)) return null;
  return object as Forward;
}

function decodeIndex(value: unknown): BindingIndex | LegacyBindingIndex | null {
  const modern = exactObject(value, ['v', 'ownerId', 'roomId', 'agentParticipantId']);
  if (modern && modern.v === 1 && identifier(modern.ownerId) && identifier(modern.roomId) && identifier(modern.agentParticipantId)) {
    return modern as BindingIndex;
  }
  const legacy = exactObject(value, ['ownerId', 'roomId']);
  return legacy && identifier(legacy.ownerId) && identifier(legacy.roomId) ? legacy as LegacyBindingIndex : null;
}

function decodeSessionLocator(value: unknown): SessionLocator | null {
  const object = exactObject(value, ['v', 'ownerId', 'roomId', 'harness', 'sessionId', 'agentParticipantId']);
  if (!object || object.v !== 1 || !identifier(object.ownerId) || !identifier(object.roomId) || !identifier(object.harness)
    || !identifier(object.sessionId) || !identifier(object.agentParticipantId)) return null;
  return object as SessionLocator;
}

function decodePendingBinding(value: unknown): PendingBinding | null {
  const object = exactObject(value, [
    'v', 'kind', 'ownerId', 'roomId', 'agentParticipantId', 'harness', 'sessionId', 'deviceId', 'generation',
  ]);
  if (!object || object.v !== 1 || object.kind !== 'binding_pending'
    || !identifier(object.ownerId) || !identifier(object.roomId) || !identifier(object.agentParticipantId)
    || !identifier(object.harness) || !identifier(object.sessionId) || !identifier(object.deviceId)
    || !Number.isSafeInteger(object.generation) || (object.generation as number) < 0) return null;
  return object as PendingBinding;
}

function bindingMatchesAddress(record: BindingRecord, address: BindingAddress): boolean {
  return record.binding.ownerId === address.ownerId && record.binding.agentParticipantId === address.agentParticipantId;
}

function pendingMatchesAddress(pending: PendingBinding, address: BindingAddress): boolean {
  return pending.ownerId === address.ownerId && pending.roomId === address.roomId
    && pending.agentParticipantId === address.agentParticipantId;
}

function samePendingIdentity(left: PendingBinding, right: PendingBinding): boolean {
  return left.harness === right.harness && left.sessionId === right.sessionId
    && left.deviceId === right.deviceId && left.generation === right.generation;
}

function pendingMatchesRecord(pending: PendingBinding, record: BindingRecord): boolean {
  return pendingMatchesAddress(pending, {
    ownerId: record.binding.ownerId, roomId: pending.roomId, agentParticipantId: record.binding.agentParticipantId,
  }) && pending.harness === record.binding.harness && pending.sessionId === record.binding.sessionId
    && pending.deviceId === record.binding.deviceId && pending.generation === record.binding.generation;
}

function validReplacement(current: BindingRecord, replacement: BindingRecord): boolean {
  const before = current.binding;
  const after = replacement.binding;
  return current.revokedGeneration !== null && replacement.revokedGeneration === null && replacement.capability === null
    && after.bindingId !== before.bindingId && after.ownerId === before.ownerId
    && after.agentParticipantId === before.agentParticipantId && after.deviceId === before.deviceId
    && after.harness === before.harness && after.sessionId === before.sessionId
    && after.generation > before.generation && after.generation >= current.revokedGeneration;
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key)) ? value as Record<string, unknown> : null;
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 512
    && !/[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u.test(value);
}

function key(kind: string, value: JsonValue): string {
  const material = typeof value === 'string' ? value : JSON.stringify(value);
  return `agent-bootstrap:${kind}:${createHash('sha256').update(`khala.agent-bootstrap.${kind}.v1\u0000${material}`).digest('hex')}`;
}

function operationId(storeKey: string, revision: string | null, value: JsonValue): string {
  return `binding-${createHash('sha256').update(JSON.stringify([storeKey, revision, value])).digest('base64url')}`;
}

function asJson(value: object): JsonValue {
  return value as unknown as JsonValue;
}
