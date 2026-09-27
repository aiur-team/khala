import { createHash } from 'node:crypto';
import type { ControlStore, JsonValue, OwnerId, SessionBinding } from '@khala/contracts/messaging/index';
import { operationJournal } from '@khala/messaging/revocation/journal';
import type { DeviceRemovalResult, DeviceStatusResult, ProtocolRevocationPort } from '@khala/messaging/revocation/index';
import { guardStore, settleWrite } from '../../auth/store';
import type { AdapterCapabilities } from '../../agent-bootstrap/handler';
import type { RouteRegistration } from '../../runtime/handler';

export const REVOCATION_CLEANUP_PATH = '/api/agent/revocation/cleanup';
export const REVOCATION_RESULT_PATH = '/api/agent/revocation/result';

type Removal = 'removed' | 'replaced' | 'reauthentication_required' | 'forbidden';
type Cleanup = Readonly<{
  v: 1; ownerId: OwnerId; operationId: string; bindingId: string; deviceId: string;
  expectedGeneration: number; revokedGeneration: number; deviceKey: string;
  capabilityDigest: string | null; removal: Removal | null;
}>;
const KEY = /^[A-Za-z0-9+/]{43}=?$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
function key(ownerId: OwnerId, operationId: string): string {
  return `revocation-cleanup.v1.${createHash('sha256').update(JSON.stringify([ownerId, operationId])).digest('hex')}`;
}
function bindingKey(ownerId: OwnerId, bindingId: string, generation: number): string {
  return `revocation-cleanup-binding.v1.${createHash('sha256').update(JSON.stringify([ownerId, bindingId, generation])).digest('hex')}`;
}
function writeId(record: Cleanup): string {
  return `revocation-cleanup.${createHash('sha256').update(JSON.stringify(record)).digest('base64url')}`;
}
function valid(value: JsonValue, ownerId: OwnerId, operationId: string): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, JsonValue>;
  return Object.keys(item).sort().join(',') === 'bindingId,capabilityDigest,deviceId,deviceKey,expectedGeneration,operationId,ownerId,removal,revokedGeneration,v'
    && item.v === 1 && item.ownerId === ownerId && item.operationId === operationId
    && typeof item.bindingId === 'string' && ID.test(item.bindingId)
    && typeof item.deviceId === 'string' && ID.test(item.deviceId)
    && typeof item.deviceKey === 'string' && KEY.test(item.deviceKey)
    && Number.isSafeInteger(item.expectedGeneration) && Number.isSafeInteger(item.revokedGeneration)
    && item.revokedGeneration === (item.expectedGeneration as number) + 1
    && (item.capabilityDigest === null || typeof item.capabilityDigest === 'string' && /^[a-f0-9]{64}$/u.test(item.capabilityDigest))
    && (item.removal === null || ['removed', 'replaced', 'reauthentication_required', 'forbidden'].includes(String(item.removal)));
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
    async findForBinding(ownerId: OwnerId, bindingId: string, generation: number) {
      const index = await guarded.read<JsonValue>(bindingKey(ownerId, bindingId, generation));
      if (index.kind !== 'record' || typeof index.record.value !== 'string' || !ID.test(index.record.value)) {
        return { kind: 'unavailable' as const };
      }
      return read(ownerId, index.record.value);
    },
    async prepare(record: Omit<Cleanup, 'v' | 'removal'>): Promise<'applied' | 'unavailable'> {
      if (!ID.test(record.operationId) || !ID.test(record.bindingId) || !ID.test(record.deviceId)
        || !KEY.test(record.deviceKey) || !Number.isSafeInteger(record.expectedGeneration)
        || record.revokedGeneration !== record.expectedGeneration + 1) return 'unavailable';
      const next: Cleanup = { ...record, v: 1, removal: null };
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
        && current.revokedGeneration === record.revokedGeneration && current.capabilityDigest === record.capabilityDigest
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
  };
}

/** Never reports removed from a queued command. Only a durable exact-device SDK receipt counts. */
export function createCleanupProtocolPort(store: ControlStore, ownerId: OwnerId): ProtocolRevocationPort {
  const cleanup = createRevocationCleanupStore(store);
  async function removal(input: { operationId: string; deviceId: string; deviceKey: string }): Promise<Removal | null> {
    const found = await cleanup.read(ownerId, input.operationId);
    return found.kind === 'record' && found.value.deviceId === input.deviceId && found.value.deviceKey === input.deviceKey
      ? found.value.removal : null;
  }
  return {
    async removeDevice(input): Promise<DeviceRemovalResult> {
      const state = await removal(input);
      return state === 'removed' || state === 'replaced' ? { kind: state }
        : state === 'forbidden' || state === 'reauthentication_required' ? { kind: 'refused', reason: state }
        : { kind: 'unavailable' };
    },
    async deviceStatus(input): Promise<DeviceStatusResult> {
      const state = await removal(input);
      return state === 'removed' || state === 'replaced' ? { kind: state } : { kind: 'unavailable' };
    },
    async rotateSessions() { return { kind: 'unavailable' as const }; },
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
    if (item.bindingId !== checked.binding.bindingId || item.deviceId !== checked.binding.deviceId
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
      if (!object(body) || Object.keys(body).sort().join(',') !== 'deviceId,deviceKey,generation,operationId,removal'
        || typeof body.operationId !== 'string' || !ID.test(body.operationId)
        || typeof body.removal !== 'string' || !['removed', 'replaced', 'reauthentication_required', 'forbidden'].includes(body.removal)) {
        return json(400, { code: 'invalid_request' });
      }
      const item = await authorized(request, body.operationId);
      if (item instanceof Response) return item;
      if (body.deviceId !== item.deviceId || body.deviceKey !== item.deviceKey || body.generation !== item.expectedGeneration) {
        return json(403, { code: 'forbidden' });
      }
      const result = await cleanup.recordRemoval(item.ownerId, item.operationId, body.removal as Removal);
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
