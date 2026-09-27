import { createHash, randomBytes } from 'node:crypto';
import {
  decodeBindingId, decodeDeviceId, decodeRoomId,
  type AuthPrincipal, type ControlStore, type DeviceId, type JsonValue, type OwnerId, type RoomId,
} from '@khala/contracts/messaging/index';
import type { AuthService } from '../../auth/index';
import type { AdapterCapabilities } from '../../agent-bootstrap/handler';
import { createAgentBindingStore } from '../../agent-bootstrap/store';
import { createOwnerRoomIndex } from '../../agent-bootstrap/owner-room-index';
import type { AdmissionGateway } from '../../invitations/index';
import type { RouteRegistration } from '../../runtime/handler';

export const OWNER_DEVICE_REGISTER = '/api/human/owner-device-proof/register';
export const OWNER_DEVICE_CHALLENGE = '/api/human/owner-device-proof/challenge';
export const OWNER_DEVICE_LOOKUP = '/api/agent/owner-device-proof/lookup';
const FINGERPRINT = /^[A-Za-z0-9+/]{43}=?$/u;
const NONCE = /^[A-Za-z0-9_-]{43}$/u;
const CHALLENGE_TTL_MS = 60_000;

export type OwnerDeviceProof = Readonly<{
  v: 1; ownerId: OwnerId; roomId: RoomId; bindingId: string; generation: number;
  deviceId: DeviceId; fingerprint: string;
}>;

export type OwnerDeviceProofDependencies = Readonly<{
  auth: Pick<AuthService, 'authenticateRequest' | 'requireHumanMutation'>;
  gateway: Pick<AdmissionGateway, 'inspectMembership'>;
  store: ControlStore;
  capabilities: Pick<AdapterCapabilities, 'authorize' | 'lookupBinding'>;
  inspectOwnerMembership(ownerId: OwnerId, roomId: RoomId): Promise<Readonly<{ kind: 'joined' | 'absent' | 'unavailable' }>>;
  /** Verify the browser token's Matrix whoami user/device and exact published key; never persist the token. */
  verifyBrowserDevice(principal: AuthPrincipal, deviceId: DeviceId, fingerprint: string, accessToken: string): Promise<'verified' | 'mismatch' | 'unavailable'>;
  clock: () => number;
  random?: (bytes: number) => Uint8Array;
}>;

/** Matrix HTTP check for the token held by the browser's opened crypto device. */
export function createMatrixBrowserDeviceVerifier(input: Readonly<{
  homeserverOrigin: string;
  serverName: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}>): OwnerDeviceProofDependencies['verifyBrowserDevice'] {
  const origin = new URL(input.homeserverOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== input.homeserverOrigin
    || origin.username || origin.password) throw new Error('Matrix origin must be exact HTTPS');
  if (!/^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/u.test(input.serverName)) throw new Error('invalid Matrix server name');
  const fetch = input.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = input.timeoutMs ?? 10_000;
  return async (principal, deviceId, fingerprint, accessToken) => {
    const expectedUser = `@khala_${Buffer.from(principal.ownerId, 'utf8').toString('base64url')}:${input.serverName}`;
    const headers = { authorization: `Bearer ${accessToken}`, accept: 'application/json' };
    try {
      const whoResponse = await fetch(`${input.homeserverOrigin}/_matrix/client/v3/account/whoami`, {
        headers, signal: AbortSignal.timeout(timeoutMs),
      });
      if (whoResponse.status === 401 || whoResponse.status === 403) return 'mismatch';
      if (whoResponse.status !== 200) return 'unavailable';
      const who: unknown = await whoResponse.json();
      if (typeof who !== 'object' || who === null || Array.isArray(who)) return 'unavailable';
      const identity = who as Record<string, unknown>;
      if (identity.user_id !== expectedUser || identity.device_id !== deviceId) return 'mismatch';
      const keysResponse = await fetch(`${input.homeserverOrigin}/_matrix/client/v3/keys/query`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ device_keys: { [expectedUser]: [deviceId] } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (keysResponse.status === 401 || keysResponse.status === 403) return 'mismatch';
      if (keysResponse.status !== 200) return 'unavailable';
      const body: unknown = await keysResponse.json();
      if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'unavailable';
      const users = (body as Record<string, unknown>).device_keys;
      if (typeof users !== 'object' || users === null || Array.isArray(users)) return 'unavailable';
      const devices = (users as Record<string, unknown>)[expectedUser];
      if (typeof devices !== 'object' || devices === null || Array.isArray(devices)) return 'unavailable';
      const device = (devices as Record<string, unknown>)[deviceId];
      if (typeof device !== 'object' || device === null || Array.isArray(device)) return 'mismatch';
      const entry = device as Record<string, unknown>;
      if (entry.user_id !== expectedUser || entry.device_id !== deviceId) return 'mismatch';
      const keys = entry.keys;
      if (typeof keys !== 'object' || keys === null || Array.isArray(keys)) return 'mismatch';
      return (keys as Record<string, unknown>)[`ed25519:${deviceId}`] === fingerprint ? 'verified' : 'mismatch';
    } catch {
      return 'unavailable';
    }
  };
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: {
    'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  } });
}
function unavailable(): Response { return json(503, { code: 'unavailable' }); }
function key(ownerId: OwnerId, roomId: RoomId, bindingId: string, generation: number, deviceId: DeviceId): string {
  return `owner-device-proof.v2.${createHash('sha256').update(JSON.stringify([ownerId, roomId, bindingId, generation, deviceId])).digest('hex')}`;
}
function indexKey(ownerId: OwnerId, roomId: RoomId, bindingId: string, generation: number): string {
  return `owner-device-index.v2.${createHash('sha256').update(JSON.stringify([ownerId, roomId, bindingId, generation])).digest('hex')}`;
}
function challengeKey(nonce: string): string {
  return `owner-device-challenge.v1.${createHash('sha256').update(nonce).digest('hex')}`;
}
function valid(value: unknown, ownerId: OwnerId, roomId: RoomId, bindingId: string, generation: number, deviceId: DeviceId): value is OwnerDeviceProof {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).sort().join(',') === 'bindingId,deviceId,fingerprint,generation,ownerId,roomId,v'
    && item.v === 1 && item.ownerId === ownerId && item.roomId === roomId
    && item.bindingId === bindingId && item.generation === generation && item.deviceId === deviceId
    && typeof item.fingerprint === 'string' && FINGERPRINT.test(item.fingerprint);
}
function validIndex(value: unknown, ownerId: OwnerId, roomId: RoomId, bindingId: string, generation: number): value is Readonly<{
  v: 1; ownerId: OwnerId; roomId: RoomId; bindingId: string; generation: number; deviceIds: readonly DeviceId[] }> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(',') !== 'bindingId,deviceIds,generation,ownerId,roomId,v' || item.v !== 1
    || item.ownerId !== ownerId || item.roomId !== roomId || item.bindingId !== bindingId
    || item.generation !== generation || !Array.isArray(item.deviceIds)
    || item.deviceIds.length > 32 || new Set(item.deviceIds).size !== item.deviceIds.length) return false;
  return item.deviceIds.every(id => decodeDeviceId(id).ok);
}
function registerBody(value: unknown): { roomId: RoomId; bindingId: string; generation: number;
  deviceId: DeviceId; fingerprint: string; nonce: string; matrixAccessToken: string } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(',') !== 'bindingId,deviceId,fingerprint,generation,matrixAccessToken,nonce,roomId,v' || item.v !== 1) return null;
  const room = decodeRoomId(item.roomId);
  const binding = decodeBindingId(item.bindingId);
  const device = decodeDeviceId(item.deviceId);
  return room.ok && binding.ok && device.ok && Number.isSafeInteger(item.generation) && (item.generation as number) >= 0
    && typeof item.fingerprint === 'string' && FINGERPRINT.test(item.fingerprint)
    && typeof item.nonce === 'string' && NONCE.test(item.nonce)
    && typeof item.matrixAccessToken === 'string' && item.matrixAccessToken.length >= 16 && item.matrixAccessToken.length <= 4096
    ? { roomId: room.value, bindingId: binding.value, generation: item.generation as number,
      deviceId: device.value, fingerprint: item.fingerprint,
      nonce: item.nonce, matrixAccessToken: item.matrixAccessToken } : null;
}

/** Owner consent pins one published browser key; an active agent may only retrieve that exact pin. */
export function createOwnerDeviceProofRoutes(deps: OwnerDeviceProofDependencies): Readonly<{
  human: readonly RouteRegistration[]; agent: readonly RouteRegistration[];
}> {
  const ownerRooms = createOwnerRoomIndex(deps.store);
  const bindings = createAgentBindingStore({ store: deps.store });

  async function humanBinding(ownerId: OwnerId, roomId: RoomId, bindingId: string,
    generation: number): Promise<Response | null> {
    const located = await bindings.locateBinding(bindingId as never);
    if (located.kind === 'unavailable') return unavailable();
    if (located.kind !== 'found' || located.address.ownerId !== ownerId
      || located.address.roomId !== roomId || located.record.revokedGeneration !== null
      || located.record.binding.bindingId !== bindingId || located.record.binding.generation !== generation) {
      return json(403, { code: 'binding_inactive' });
    }
    const current = await deps.capabilities.lookupBinding(bindingId as never);
    if (current.kind === 'unavailable') return unavailable();
    if (current.kind !== 'found' || current.status !== 'active' || current.ownerId !== ownerId
      || current.generation !== generation || current.deviceId !== located.record.binding.deviceId) {
      return json(403, { code: 'binding_inactive' });
    }
    return null;
  }

  async function indexPinnedDevice(proof: OwnerDeviceProof): Promise<boolean> {
    const name = indexKey(proof.ownerId, proof.roomId, proof.bindingId, proof.generation);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await deps.store.read<JsonValue>(name);
      if (current.kind === 'unavailable') return false;
      if (current.kind === 'record' && !validIndex(current.record.value,
        proof.ownerId, proof.roomId, proof.bindingId, proof.generation)) return false;
      const deviceIds = current.kind === 'record' ? [...(current.record.value as { deviceIds: DeviceId[] }).deviceIds] : [];
      if (deviceIds.includes(proof.deviceId)) return true;
      if (deviceIds.length >= 32) return false;
      deviceIds.push(proof.deviceId);
      deviceIds.sort();
      const saved = await deps.store.compareAndSet<JsonValue>({ key: name,
        expectedRevision: current.kind === 'record' ? current.record.revision : null,
        operationId: `owner-device-index.${createHash('sha256').update(JSON.stringify([proof.ownerId, proof.roomId, proof.bindingId, proof.generation, deviceIds])).digest('hex')}`,
        next: { value: { v: 1, ownerId: proof.ownerId, roomId: proof.roomId,
          bindingId: proof.bindingId, generation: proof.generation, deviceIds }, expiresAt: null },
      });
      if (saved.kind === 'applied') return true;
      if (saved.kind !== 'conflict') return false;
    }
    return false;
  }

  async function challenge(request: Request): Promise<Response> {
    const signed = await deps.auth.authenticateRequest(request);
    if (signed.kind === 'unavailable') return unavailable();
    if (signed.kind !== 'authenticated') return json(401, { code: 'authentication_required' });
    const search = new URL(request.url).searchParams;
    if ([...search.keys()].sort().join(',') !== 'binding_generation,binding_id,device_id,room_id') return json(400, { code: 'invalid_request' });
    const room = decodeRoomId(search.get('room_id'));
    const binding = decodeBindingId(search.get('binding_id'));
    const generation = Number(search.get('binding_generation'));
    const device = decodeDeviceId(search.get('device_id'));
    if (!room.ok || !binding.ok || !Number.isSafeInteger(generation) || generation < 0 || !device.ok) {
      return json(400, { code: 'invalid_request' });
    }
    const open = await roomOpen(signed.context.principal.ownerId, room.value);
    if (open) return open;
    const heldBinding = await humanBinding(signed.context.principal.ownerId, room.value, binding.value, generation);
    if (heldBinding) return heldBinding;
    const membership = await deps.gateway.inspectMembership({ roomId: room.value,
      principal: signed.context.principal, history: 'none' });
    if (membership.kind === 'unavailable') return unavailable();
    if (membership.kind !== 'joined') return json(403, { code: 'owner_membership_required' });
    const nonce = Buffer.from((deps.random ?? randomBytes)(32)).toString('base64url');
    const expiresAt = new Date(deps.clock() + CHALLENGE_TTL_MS).toISOString();
    const saved = await deps.store.compareAndSet<JsonValue>({ key: challengeKey(nonce), expectedRevision: null,
      operationId: `owner-device.challenge.${nonce}`,
      next: { value: { v: 1, ownerId: signed.context.principal.ownerId, roomId: room.value,
        bindingId: binding.value, generation, deviceId: device.value, used: false }, expiresAt } });
    return saved.kind === 'applied' ? json(200, { v: 1, nonce, expiresAt }) : unavailable();
  }

  async function roomOpen(ownerId: OwnerId, roomId: RoomId): Promise<Response | null> {
    const indexed = await ownerRooms.inspect(ownerId, roomId);
    if (indexed.kind !== 'ok') return unavailable();
    if (indexed.value?.marker) return json(403, { code: 'channel_closing' });
    return null;
  }

  async function register(request: Request): Promise<Response> {
    const signed = await deps.auth.requireHumanMutation(request);
    if (signed.kind === 'unavailable') return unavailable();
    if (signed.kind !== 'authorized') return json(signed.code === 'signed_out' ? 401 : 403, { code: signed.code });
    let body: ReturnType<typeof registerBody> = null;
    if ((request.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      return json(400, { code: 'invalid_request' });
    }
    try { body = registerBody(await request.json()); } catch { /* malformed */ }
    if (!body) return json(400, { code: 'invalid_request' });
    const { principal } = signed.context;
    const open = await roomOpen(principal.ownerId, body.roomId);
    if (open) return open;
    const heldBinding = await humanBinding(principal.ownerId, body.roomId, body.bindingId, body.generation);
    if (heldBinding) return heldBinding;
    const membership = await deps.gateway.inspectMembership({ roomId: body.roomId, principal, history: 'none' });
    if (membership.kind === 'unavailable') return unavailable();
    if (membership.kind !== 'joined') return json(403, { code: 'owner_membership_required' });
    const held = await deps.store.read<JsonValue>(challengeKey(body.nonce));
    if (held.kind === 'unavailable') return unavailable();
    if (held.kind !== 'record') return json(403, { code: 'challenge_unavailable' });
    const challengeValue = held.record.value;
    if (typeof challengeValue !== 'object' || challengeValue === null || Array.isArray(challengeValue)) return unavailable();
    const expected = challengeValue as Record<string, JsonValue>;
    if (expected.v !== 1 || expected.ownerId !== principal.ownerId || expected.roomId !== body.roomId
      || expected.bindingId !== body.bindingId || expected.generation !== body.generation
      || expected.deviceId !== body.deviceId || expected.used !== false) return json(403, { code: 'challenge_mismatch' });
    const consumed = await deps.store.compareAndSet<JsonValue>({ key: challengeKey(body.nonce),
      expectedRevision: held.record.revision,
      operationId: `owner-device.consume.${body.nonce}`,
      next: { value: { ...expected, used: true }, expiresAt: held.record.expiresAt } });
    if (consumed.kind !== 'applied') return json(403, { code: 'challenge_replayed' });
    const verified = await deps.verifyBrowserDevice(principal, body.deviceId, body.fingerprint, body.matrixAccessToken);
    if (verified === 'unavailable') return unavailable();
    if (verified !== 'verified') return json(403, { code: 'fingerprint_mismatch' });
    const stillMember = await deps.gateway.inspectMembership({ roomId: body.roomId, principal, history: 'none' });
    if (stillMember.kind === 'unavailable') return unavailable();
    if (stillMember.kind !== 'joined') return json(403, { code: 'owner_membership_required' });
    const stillOpen = await roomOpen(principal.ownerId, body.roomId);
    if (stillOpen) return stillOpen;
    const stillHeld = await humanBinding(principal.ownerId, body.roomId, body.bindingId, body.generation);
    if (stillHeld) return stillHeld;
    const proof: OwnerDeviceProof = { v: 1, ownerId: principal.ownerId, roomId: body.roomId,
      bindingId: body.bindingId, generation: body.generation,
      deviceId: body.deviceId, fingerprint: body.fingerprint };
    const recordKey = key(proof.ownerId, proof.roomId, proof.bindingId, proof.generation, proof.deviceId);
    const operationId = `owner-device-proof.${createHash('sha256').update(JSON.stringify(proof)).digest('hex')}`;
    const saved = await deps.store.compareAndSet<JsonValue>({ key: recordKey, expectedRevision: null,
      operationId, next: { value: proof, expiresAt: null } });
    if (saved.kind === 'applied' || (saved.kind === 'conflict'
      && valid(saved.current?.value, proof.ownerId, proof.roomId, proof.bindingId, proof.generation, proof.deviceId)
      && saved.current.value.fingerprint === proof.fingerprint)) {
      return await indexPinnedDevice(proof) ? json(200, { v: 1, kind: 'pinned' }) : unavailable();
    }
    if (saved.kind === 'conflict') return json(409, { code: 'key_replacement_refused' });
    return unavailable();
  }

  async function lookup(request: Request): Promise<Response> {
    const auth = await deps.capabilities.authorize(request, 'receive_released');
    if (auth.kind === 'unavailable') return unavailable();
    if (auth.kind !== 'authorized') return json(auth.status, { code: auth.code });
    const current = await deps.capabilities.lookupBinding(auth.binding.bindingId);
    if (current.kind === 'unavailable') return unavailable();
    if (current.kind !== 'found' || current.status !== 'active' || current.ownerId !== auth.ownerId
      || current.deviceId !== auth.binding.deviceId || current.generation !== auth.binding.generation
      || auth.binding.ownerId !== auth.ownerId) return json(403, { code: 'binding_inactive' });
    const located = await bindings.locateBinding(auth.binding.bindingId);
    if (located.kind === 'unavailable') return unavailable();
    if (located.kind !== 'found' || located.record.revokedGeneration !== null
      || located.address.ownerId !== auth.ownerId || located.address.roomId !== auth.roomId
      || located.record.binding.bindingId !== auth.binding.bindingId
      || located.record.binding.ownerId !== auth.ownerId
      || located.record.binding.deviceId !== auth.binding.deviceId
      || located.record.binding.generation !== auth.binding.generation) return json(403, { code: 'binding_mismatch' });
    const open = await roomOpen(auth.ownerId, auth.roomId);
    if (open) return open;
    const membership = await deps.inspectOwnerMembership(auth.ownerId, auth.roomId);
    if (membership.kind === 'unavailable') return unavailable();
    if (membership.kind !== 'joined') return json(403, { code: 'owner_membership_required' });
    const search = new URL(request.url).searchParams;
    if ([...search.keys()].length === 0) {
      const indexed = await deps.store.read<JsonValue>(indexKey(auth.ownerId, auth.roomId,
        auth.binding.bindingId, auth.binding.generation));
      if (indexed.kind === 'unavailable') return unavailable();
      if (indexed.kind === 'absent') return json(200, { v: 1, roomId: auth.roomId, devices: [] });
      if (!validIndex(indexed.record.value, auth.ownerId, auth.roomId,
        auth.binding.bindingId, auth.binding.generation)) return unavailable();
      const devices: Array<{ deviceId: DeviceId; fingerprint: string }> = [];
      for (const deviceId of indexed.record.value.deviceIds) {
        const found = await deps.store.read<JsonValue>(key(auth.ownerId, auth.roomId,
          auth.binding.bindingId, auth.binding.generation, deviceId));
        if (found.kind !== 'record' || !valid(found.record.value, auth.ownerId, auth.roomId,
          auth.binding.bindingId, auth.binding.generation, deviceId)) return unavailable();
        devices.push({ deviceId, fingerprint: found.record.value.fingerprint });
      }
      return json(200, { v: 1, roomId: auth.roomId, devices });
    }
    if ([...search.keys()].join(',') !== 'device_id') return json(400, { code: 'invalid_request' });
    const device = decodeDeviceId(search.get('device_id'));
    if (!device.ok) return json(400, { code: 'invalid_request' });
    const read = await deps.store.read<JsonValue>(key(auth.ownerId, auth.roomId,
      auth.binding.bindingId, auth.binding.generation, device.value));
    if (read.kind === 'unavailable') return unavailable();
    if (read.kind !== 'record') return json(404, { code: 'not_found' });
    if (!valid(read.record.value, auth.ownerId, auth.roomId,
      auth.binding.bindingId, auth.binding.generation, device.value)) return unavailable();
    return json(200, { v: 1, roomId: auth.roomId, deviceId: device.value,
      fingerprint: read.record.value.fingerprint });
  }

  return { human: Object.freeze([
    { path: OWNER_DEVICE_CHALLENGE, methods: ['GET'], handle: challenge },
    { path: OWNER_DEVICE_REGISTER, methods: ['POST'], handle: register },
  ]),
    agent: Object.freeze([{ path: OWNER_DEVICE_LOOKUP, methods: ['GET'], handle: lookup }]) };
}

export function unavailableOwnerDeviceProofRoutes(): ReturnType<typeof createOwnerDeviceProofRoutes> {
  const absent = (path: string, method: string): RouteRegistration => Object.freeze({
    path, methods: Object.freeze([method]), handle: async () => unavailable(),
  });
  return { human: Object.freeze([absent(OWNER_DEVICE_CHALLENGE, 'GET'), absent(OWNER_DEVICE_REGISTER, 'POST')]),
    agent: Object.freeze([absent(OWNER_DEVICE_LOOKUP, 'GET')]) };
}

/** Static gateway route metadata; production dependencies are resolved for each request. */
export function createLazyOwnerDeviceProofRoutes(
  load: () => ReturnType<typeof createOwnerDeviceProofRoutes>,
): ReturnType<typeof createOwnerDeviceProofRoutes> {
  const absent = unavailableOwnerDeviceProofRoutes();
  return { human: absent.human.map((route, index) => Object.freeze({ ...route,
    handle: (request: Request) => load().human[index]!.handle(request) })),
    agent: [Object.freeze({ ...absent.agent[0]!,
      handle: (request: Request) => load().agent[0]!.handle(request) })] };
}
