import { createHash } from 'node:crypto';
import type { ControlStore, JsonValue, OwnerId, RoomId } from '@khala/contracts/messaging/index';
import { operationJournal } from '@khala/messaging/revocation/journal';
import type { DeviceRemovalResult, DeviceStatusResult, ProtocolRevocationPort } from '@khala/messaging/revocation/index';
import { guardStore, settleWrite } from '../../auth/store';
import type { AdapterCapabilities } from '../../agent-bootstrap/handler';
import type { RouteRegistration } from '../../runtime/handler';
import { createRoomSendFence } from './room-send-fence';

export const REVOCATION_CLEANUP_PATH = '/api/agent/revocation/cleanup';
export const REVOCATION_RESULT_PATH = '/api/agent/revocation/result';

type Removal = 'removed' | 'replaced' | 'reauthentication_required' | 'forbidden';
export type RevocationLocalStop = Readonly<{
  operationId: string; ownerId: OwnerId; roomId: RoomId; expectedRoomRevision: 0;
  bindingId: string; bindingGeneration: number; state: 'stopped'; cleanupRequested: true;
}>;
type Cleanup = Readonly<{
  v: 1; ownerId: OwnerId; operationId: string; bindingId: string; roomId: RoomId; deviceId: string;
  expectedGeneration: number; revokedGeneration: number; deviceKey: string;
  capabilityDigest: string | null; removal: Removal | null; verifiedRemoval: 'removed' | 'replaced' | null;
}>;
const KEY = /^[A-Za-z0-9+/]{43}=?$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
function key(ownerId: OwnerId, operationId: string): string {
  return `revocation-cleanup.v1.${createHash('sha256').update(JSON.stringify([ownerId, operationId])).digest('hex')}`;
}
function bindingKey(ownerId: OwnerId, bindingId: string, generation: number): string {
  return `revocation-cleanup-binding.v1.${createHash('sha256').update(JSON.stringify([ownerId, bindingId, generation])).digest('hex')}`;
}
function stopKey(ownerId: OwnerId, operationId: string): string {
  return `revocation-local-stop.v1.${createHash('sha256').update(JSON.stringify([ownerId, operationId])).digest('hex')}`;
}
export function revocationStopId(operationId: string, bindingId: string): string {
  return `revoke_${createHash('sha256').update(JSON.stringify([operationId, bindingId])).digest('hex').slice(0, 40)}`;
}
function validStop(value: unknown, item: Cleanup): value is RevocationLocalStop {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const stop = value as Record<string, unknown>;
  return Object.keys(stop).sort().join(',') === 'bindingGeneration,bindingId,cleanupRequested,expectedRoomRevision,operationId,ownerId,roomId,state'
    && stop.operationId === revocationStopId(item.operationId, item.bindingId)
    && stop.ownerId === item.ownerId && stop.roomId === item.roomId
    && stop.expectedRoomRevision === 0 && stop.bindingId === item.bindingId
    && stop.bindingGeneration === item.expectedGeneration && stop.state === 'stopped'
    && stop.cleanupRequested === true;
}
function writeId(record: Cleanup): string {
  return `revocation-cleanup.${createHash('sha256').update(JSON.stringify(record)).digest('base64url')}`;
}
function valid(value: JsonValue, ownerId: OwnerId, operationId: string): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, JsonValue>;
  return Object.keys(item).sort().join(',') === 'bindingId,capabilityDigest,deviceId,deviceKey,expectedGeneration,operationId,ownerId,removal,revokedGeneration,roomId,v,verifiedRemoval'
    && item.v === 1 && item.ownerId === ownerId && item.operationId === operationId
    && typeof item.bindingId === 'string' && ID.test(item.bindingId)
    && typeof item.roomId === 'string' && item.roomId.startsWith('!')
    && typeof item.deviceId === 'string' && ID.test(item.deviceId)
    && typeof item.deviceKey === 'string' && KEY.test(item.deviceKey)
    && Number.isSafeInteger(item.expectedGeneration) && Number.isSafeInteger(item.revokedGeneration)
    && item.revokedGeneration === (item.expectedGeneration as number) + 1
    && (item.capabilityDigest === null || typeof item.capabilityDigest === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(item.capabilityDigest))
    && (item.removal === null || ['removed', 'replaced', 'reauthentication_required', 'forbidden'].includes(String(item.removal)))
    && (item.verifiedRemoval === null || item.verifiedRemoval === 'removed' || item.verifiedRemoval === 'replaced');
}

export function createRevocationCleanupStore(store: ControlStore) {
  const guarded = guardStore(store);
  async function read(ownerId: OwnerId, operationId: string) {
    const result = await guarded.read<JsonValue>(key(ownerId, operationId));
    if (result.kind !== 'record') return result;
    return valid(result.record.value, ownerId, operationId)
      ? { kind: 'record' as const, value: result.record.value as unknown as Cleanup, revision: result.record.revision }
      : { kind: 'unavailable' as const };
  }
  return {
    read,
    async localStop(item: Cleanup) {
      const found = await guarded.read<JsonValue>(stopKey(item.ownerId, item.operationId));
      if (found.kind !== 'record') return found;
      return validStop(found.record.value, item)
        ? { kind: 'record' as const, value: found.record.value as unknown as RevocationLocalStop }
        : { kind: 'unavailable' as const };
    },
    async recordLocalStop(item: Cleanup, receipt: unknown): Promise<'applied' | 'unavailable'> {
      if (!validStop(receipt, item)) return 'unavailable';
      const saved = await settleWrite(guarded, { key: stopKey(item.ownerId, item.operationId), expectedRevision: null,
        operationId: `revocation-local-stop.${createHash('sha256').update(JSON.stringify(receipt)).digest('hex')}`,
        next: { value: receipt as unknown as JsonValue, expiresAt: null } });
      if (saved.kind === 'applied') return 'applied';
      if (saved.kind !== 'conflict') return 'unavailable';
      const prior = await guarded.read<JsonValue>(stopKey(item.ownerId, item.operationId));
      return prior.kind === 'record' && validStop(prior.record.value, item) ? 'applied' : 'unavailable';
    },
    async findForBinding(ownerId: OwnerId, bindingId: string, generation: number) {
      const index = await guarded.read<JsonValue>(bindingKey(ownerId, bindingId, generation));
      if (index.kind !== 'record' || typeof index.record.value !== 'string' || !ID.test(index.record.value)) {
        return { kind: 'unavailable' as const };
      }
      return read(ownerId, index.record.value);
    },
    async prepare(record: Omit<Cleanup, 'v' | 'removal' | 'verifiedRemoval'>): Promise<'applied' | 'unavailable'> {
      if (!ID.test(record.operationId) || !ID.test(record.bindingId) || !ID.test(record.deviceId)
        || !KEY.test(record.deviceKey)
        || record.capabilityDigest !== null && !/^[A-Za-z0-9_-]{43}$/u.test(record.capabilityDigest)
        || !Number.isSafeInteger(record.expectedGeneration)
        || record.revokedGeneration !== record.expectedGeneration + 1) return 'unavailable';
      const next: Cleanup = { ...record, v: 1, removal: null, verifiedRemoval: null };
      const indexKey = bindingKey(record.ownerId, record.bindingId, record.expectedGeneration);
      const indexed = await settleWrite(guarded, { key: indexKey, expectedRevision: null,
        operationId: `revocation-cleanup-index.${createHash('sha256').update(indexKey).digest('hex')}`,
        next: { value: record.operationId, expiresAt: null } });
      if (indexed.kind !== 'applied' && (indexed.kind !== 'conflict'
        || indexed.current?.value !== record.operationId)) return 'unavailable';
      const result = await settleWrite(guarded, { key: key(record.ownerId, record.operationId), expectedRevision: null,
        operationId: writeId(next), next: { value: next as unknown as JsonValue, expiresAt: null } });
      if (result.kind === 'applied') return 'applied';
      if (result.kind !== 'conflict' || !result.current || !valid(result.current.value, record.ownerId, record.operationId)) return 'unavailable';
      const current = result.current.value as unknown as Cleanup;
      return current.bindingId === record.bindingId && current.deviceId === record.deviceId
        && current.deviceKey === record.deviceKey && current.expectedGeneration === record.expectedGeneration
        && current.revokedGeneration === record.revokedGeneration && current.roomId === record.roomId
        && current.capabilityDigest === record.capabilityDigest
        ? 'applied' : 'unavailable';
    },
    async recordRemoval(ownerId: OwnerId, operationId: string, result: Removal): Promise<'applied' | 'unavailable'> {
      for (let attempt = 0; attempt < 8; attempt++) {
        const found = await read(ownerId, operationId);
        if (found.kind !== 'record') return 'unavailable';
        if (found.value.removal !== null) return found.value.removal === result ? 'applied' : 'unavailable';
        const next: Cleanup = { ...found.value, removal: result };
        const written = await settleWrite(guarded, { key: key(ownerId, operationId), expectedRevision: found.revision,
          operationId: writeId(next), next: { value: next as unknown as JsonValue, expiresAt: null } });
        if (written.kind === 'applied') return 'applied';
        if (written.kind !== 'conflict') return 'unavailable';
      }
      return 'unavailable';
    },
    async recordVerifiedRemoval(ownerId: OwnerId, operationId: string, result: 'removed' | 'replaced'): Promise<'applied' | 'unavailable'> {
      for (let attempt = 0; attempt < 8; attempt++) {
        const found = await read(ownerId, operationId);
        if (found.kind !== 'record' || (found.value.removal !== null
          && found.value.removal !== 'reauthentication_required' && found.value.removal !== 'forbidden')) return 'unavailable';
        if (found.value.verifiedRemoval !== null) return found.value.verifiedRemoval === result ? 'applied' : 'unavailable';
        const next: Cleanup = { ...found.value, verifiedRemoval: result };
        const saved = await settleWrite(guarded, { key: key(ownerId, operationId), expectedRevision: found.revision,
          operationId: writeId(next), next: { value: next as unknown as JsonValue, expiresAt: null } });
        if (saved.kind === 'applied') return 'applied';
        if (saved.kind !== 'conflict') return 'unavailable';
      }
      return 'unavailable';
    },
  };
}

/** Never reports removed from a queued command. Only a durable exact-device SDK receipt counts. */
export type UIADeviceRemoval = Readonly<{
  remove(input: Readonly<{ bindingId: string; roomId: RoomId; deviceId: string; deviceKey: string;
    expectedGeneration: number; revokedGeneration: number }>): Promise<'removed' | 'replaced' | 'reauthentication_required' | 'forbidden' | 'outcome_unknown' | 'unavailable'>;
  status(input: Readonly<{ bindingId: string; roomId: RoomId; deviceId: string; deviceKey: string;
    expectedGeneration: number; revokedGeneration: number }>): Promise<'removed' | 'present' | 'replaced' | 'unavailable'>;
}>;

export function createCleanupProtocolPort(store: ControlStore, ownerId: OwnerId, uia?: UIADeviceRemoval): ProtocolRevocationPort {
  const cleanup = createRevocationCleanupStore(store);
  const sendFence = createRoomSendFence(store);
  async function matching(input: { operationId: string; deviceId: string; deviceKey: string }): Promise<Cleanup | null> {
    const found = await cleanup.read(ownerId, input.operationId);
    return found.kind === 'record' && found.value.deviceId === input.deviceId && found.value.deviceKey === input.deviceKey
      ? found.value : null;
  }
  function uiaInput(item: Cleanup) { return { bindingId: item.bindingId, roomId: item.roomId,
    deviceId: item.deviceId, deviceKey: item.deviceKey,
    expectedGeneration: item.expectedGeneration, revokedGeneration: item.revokedGeneration }; }
  async function confirmed(item: Cleanup, result: 'removed' | 'replaced'): Promise<DeviceRemovalResult> {
    return await cleanup.recordVerifiedRemoval(ownerId, item.operationId, result) === 'applied'
      ? { kind: result } : { kind: 'unavailable' };
  }
  return {
    async removeDevice(input): Promise<DeviceRemovalResult> {
      const item = await matching(input);
      if (!item) return { kind: 'unavailable' };
      if (item.verifiedRemoval) return { kind: item.verifiedRemoval };
      if (await sendFence.beginHold(item.roomId, item.operationId, item.deviceKey) !== 'held'
        || await sendFence.drained(item.roomId, item.operationId) !== 'drained') return { kind: 'unavailable' };
      if (item.removal === 'removed' || item.removal === 'replaced') return { kind: item.removal };
      let refusal: 'reauthentication_required' | 'forbidden' = item.removal === 'forbidden'
        ? 'forbidden' : 'reauthentication_required';
      if (uia) {
        const result = await uia.remove(uiaInput(item));
        if (result === 'removed' || result === 'replaced') return confirmed(item, result);
        if (result === 'outcome_unknown') return { kind: 'outcome_unknown' };
        if (result === 'unavailable') return { kind: 'unavailable' };
        refusal = result;
      }
      if (item.removal === 'forbidden' || item.removal === 'reauthentication_required' || uia) {
        if (await sendFence.releaseHold(item.roomId, item.operationId, 'refused') !== 'applied') return { kind: 'unavailable' };
        return { kind: 'refused', reason: refusal };
      }
      return { kind: 'unavailable' };
    },
    async deviceStatus(input): Promise<DeviceStatusResult> {
      const item = await matching(input);
      if (!item) return { kind: 'unavailable' };
      if (item.verifiedRemoval) return { kind: item.verifiedRemoval };
      if (item.removal === 'removed' || item.removal === 'replaced') return { kind: item.removal };
      if (!uia) return { kind: 'unavailable' };
      const state = await uia.status(uiaInput(item));
      if (state === 'removed' || state === 'replaced') {
        const saved = await confirmed(item, state);
        return saved.kind === state ? { kind: state } : { kind: 'unavailable' };
      }
      return { kind: state };
    },
    async rotateSessions(input) {
      const record = await cleanup.read(ownerId, input.operationId);
      if (record.kind !== 'record' || record.value.deviceId !== input.deviceId
        || record.value.deviceKey !== input.deviceKey) return { kind: 'unavailable' as const };
      if (await sendFence.rotationStatus(record.value.roomId, input.operationId) !== 'rotated') {
        return { kind: 'unavailable' as const };
      }
      return await sendFence.releaseHold(record.value.roomId, input.operationId, 'rotated') === 'applied'
        ? { kind: 'rotated' as const } : { kind: 'unavailable' as const };
    },
  };
}

function json(status: number, body: unknown): Response { return new Response(JSON.stringify(body), { status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } }); }
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

export function createAgentRevocationCleanupRoutes(input: Readonly<{
  store: ControlStore;
  capabilities: Pick<AdapterCapabilities, 'authorizeRevocationCleanup'>;
}>): readonly RouteRegistration[] {
  const cleanup = createRevocationCleanupStore(input.store);
  async function authorized(request: Request, operationId: string | null) {
    const checked = await input.capabilities.authorizeRevocationCleanup(request);
    if (checked.kind !== 'authorized') return json(checked.kind === 'unavailable' ? 503 : checked.status,
      { code: checked.kind === 'unavailable' ? 'unavailable' : checked.code });
    const found = operationId === null
      ? await cleanup.findForBinding(checked.ownerId, checked.binding.bindingId, checked.binding.generation)
      : await cleanup.read(checked.ownerId, operationId);
    if (found.kind !== 'record') return json(found.kind === 'absent' ? 404 : 503, { code: 'unavailable' });
    const item = found.value;
    if (operationId !== null && item.operationId !== operationId) return json(403, { code: 'forbidden' });
    if (item.ownerId !== checked.ownerId || item.roomId !== checked.roomId
      || item.bindingId !== checked.binding.bindingId || item.deviceId !== checked.binding.deviceId
      || item.expectedGeneration !== checked.binding.generation || item.revokedGeneration !== checked.revokedGeneration
      || item.capabilityDigest === null || item.capabilityDigest !== checked.capabilityDigest) return json(403, { code: 'forbidden' });
    const journal = await operationJournal(checked.ownerId, input.store).load(item.operationId);
    if (journal.kind !== 'found' || journal.stored.record.control !== 'disabled'
      || journal.stored.record.targetKind !== 'binding' || journal.stored.record.targetId !== item.bindingId
      || journal.stored.record.deviceId !== item.deviceId || journal.stored.record.deviceKey !== item.deviceKey
      || journal.stored.record.revokedGeneration !== item.revokedGeneration) return json(503, { code: 'unavailable' });
    return item;
  }
  return Object.freeze([
    { path: REVOCATION_CLEANUP_PATH, methods: ['GET'], async handle(request) {
      const search = new URL(request.url).searchParams;
      if ([...search.keys()].length !== 0) return json(400, { code: 'invalid_request' });
      const item = await authorized(request, null);
      if (item instanceof Response) return item;
      return json(200, { v: 1, operationId: item.operationId, deviceId: item.deviceId, deviceKey: item.deviceKey,
        generation: item.expectedGeneration, removal: item.removal });
    } },
    { path: REVOCATION_RESULT_PATH, methods: ['POST'], async handle(request) {
      if ((request.headers.get('content-type') ?? '').split(';')[0]?.trim() !== 'application/json') return json(400, { code: 'invalid_request' });
      let body: unknown;
      try { body = await request.json(); } catch { return json(400, { code: 'invalid_request' }); }
      if (!object(body) || !['deviceId,deviceKey,generation,operationId,removal',
        'deviceId,deviceKey,generation,localStop,operationId,removal'].includes(Object.keys(body).sort().join(','))
        || typeof body.operationId !== 'string' || !ID.test(body.operationId)
        || !(body.removal === null && 'localStop' in body
          || typeof body.removal === 'string' && ['removed', 'replaced', 'reauthentication_required', 'forbidden'].includes(body.removal))) {
        return json(400, { code: 'invalid_request' });
      }
      const item = await authorized(request, body.operationId);
      if (item instanceof Response) return item;
      if (body.deviceId !== item.deviceId || body.deviceKey !== item.deviceKey || body.generation !== item.expectedGeneration) {
        return json(403, { code: 'forbidden' });
      }
      const stopped = !('localStop' in body) || await cleanup.recordLocalStop(item, body.localStop) === 'applied';
      if (!stopped) return json(503, { code: 'unavailable' });
      const result = body.removal === null ? 'applied'
        : await cleanup.recordRemoval(item.ownerId, item.operationId, body.removal as Removal);
      return result === 'applied' ? json(200, { v: 1, operationId: item.operationId, removal: body.removal })
        : json(503, { code: 'unavailable' });
    } },
  ]);
}

export function createLazyAgentRevocationCleanupRoutes(load: () => readonly RouteRegistration[]): readonly RouteRegistration[] {
  const route = (path: string, methods: readonly string[]): RouteRegistration => ({ path, methods,
    async handle(request) {
      const registration = load().find(item => item.path === path);
      return registration ? registration.handle(request) : json(503, { code: 'unavailable' });
    },
  });
  return Object.freeze([route(REVOCATION_CLEANUP_PATH, ['GET']), route(REVOCATION_RESULT_PATH, ['POST'])]);
}
