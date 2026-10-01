import { decodeRoomId, type AuthPrincipal, type ControlStore, type RoomId, type SessionBinding } from '@khala/contracts/messaging/index';
import type { AuthService } from '../../auth/index';
import type { AdapterCapabilities } from '../../agent-bootstrap/handler';
import type { RouteRegistration } from '../../runtime/handler';
import { createRoomSendFence, senderIdFor, type SenderIdentity } from './room-send-fence';
import { createOwnerRoomIndex } from '../../agent-bootstrap/owner-room-index';
import { ownerMatrixUserId } from './matrix-identity';

const HUMAN = '/api/human/room-send';
const AGENT = '/api/agent/room-send';
const ACTIONS = ['ready', 'acquire', 'finish', 'rotation', 'inspect'] as const;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
type Action = typeof ACTIONS[number];
type Principal = Readonly<{ roomId: RoomId; sender: SenderIdentity }>;
export type RoomSendFailureStage = 'auth' | 'membership' | 'sender' | 'fence_acquire' | 'composition';
export type RoomSendFailureCode = 'session_store_unavailable' | 'matrix_unavailable' | 'fence_unavailable'
  | 'sender_verification_unavailable' | 'load_failed' | 'route_missing' | 'handle_failed';
export type RoomSendDiagnostic = (entry: Readonly<{ stage: RoomSendFailureStage; code: RoomSendFailureCode }>) => void;
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function json(status: number, value: unknown): Response { return new Response(JSON.stringify(value), { status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } }); }
function validBody(value: unknown, human: boolean, action: Action): value is Record<string, unknown> {
  if (!object(value)) return false;
  const common = human ? ['roomId', 'deviceId', 'matrixAccessToken'] : [];
  const extras = action === 'acquire' ? ['clientTxnId'] : action === 'finish'
    ? ['permitId', 'outcome', 'eventId', ...(!human && 'attempt' in value ? ['attempt'] : [])]
    : action === 'rotation' ? ['operationId', 'epoch'] : [];
  const keys = [...common, ...extras].sort();
  if (Object.keys(value).sort().join(',') !== keys.join(',')) return false;
  if (human && (typeof value.roomId !== 'string' || typeof value.deviceId !== 'string'
    || typeof value.matrixAccessToken !== 'string' || value.matrixAccessToken.length < 16
    || value.matrixAccessToken.length > 4096)) return false;
  if (action === 'acquire' && (typeof value.clientTxnId !== 'string' || !ID.test(value.clientTxnId))) return false;
  if (action === 'finish' && (typeof value.permitId !== 'string' || !ID.test(value.permitId)
    || value.attempt !== undefined && (!Number.isSafeInteger(value.attempt) || (value.attempt as number) < 0)
    || !['complete', 'unknown', 'cancelled'].includes(String(value.outcome))
    || (value.outcome === 'complete' ? typeof value.eventId !== 'string' || !value.eventId.startsWith('$') : value.eventId !== null))) return false;
  if (action === 'rotation' && (typeof value.operationId !== 'string' || !ID.test(value.operationId)
    || !Number.isSafeInteger(value.epoch) || (value.epoch as number) < 1)) return false;
  return true;
}

/** Browser token is checked against Matrix whoami and the exact published Curve25519 device key. */
export type BrowserSenderVerifier = (principal: AuthPrincipal, deviceId: string, accessToken: string) =>
  Promise<Readonly<{ matrixUserId: string; deviceKey: string }> | null>;

export function createMatrixBrowserSenderVerifier(input: Readonly<{
  homeserverOrigin: string; serverName: string; allowInsecureLoopback?: boolean; fetch?: typeof globalThis.fetch;
}>): BrowserSenderVerifier {
  const origin = new URL(input.homeserverOrigin);
  const loopback = input.allowInsecureLoopback === true && origin.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (origin.origin !== input.homeserverOrigin || !(origin.protocol === 'https:' || loopback)) throw new Error('invalid_matrix_origin');
  const transport = input.fetch ?? globalThis.fetch.bind(globalThis);
  return async (principal, deviceId, accessToken) => {
    const matrixUserId = ownerMatrixUserId(principal.ownerId, input.serverName);
    const headers = { authorization: `Bearer ${accessToken}`, accept: 'application/json' };
    try {
      const who = await transport(`${input.homeserverOrigin}/_matrix/client/v3/account/whoami`, {
        headers, signal: AbortSignal.timeout(10_000), redirect: 'error',
      });
      if (who.status !== 200) return null;
      const identity: unknown = await who.json();
      if (!object(identity) || identity.user_id !== matrixUserId || identity.device_id !== deviceId) return null;
      const keys = await transport(`${input.homeserverOrigin}/_matrix/client/v3/keys/query`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ device_keys: { [matrixUserId]: [deviceId] } }),
        signal: AbortSignal.timeout(10_000), redirect: 'error',
      });
      if (keys.status !== 200) return null;
      const result: unknown = await keys.json();
      const users = object(result) && object(result.device_keys) ? result.device_keys : null;
      const devices = users && object(users[matrixUserId]) ? users[matrixUserId] : null;
      const published = devices && object(devices[deviceId]) ? devices[deviceId] : null;
      const deviceKeys = published && object(published.keys) ? published.keys : null;
      const deviceKey = deviceKeys?.[`curve25519:${deviceId}`];
      return published?.user_id === matrixUserId && published.device_id === deviceId
        && typeof deviceKey === 'string' && /^[A-Za-z0-9+/]{43}=?$/u.test(deviceKey)
        ? { matrixUserId, deviceKey } : null;
    } catch { return null; }
  };
}

/** Every command is bound to the authenticated endpoint's own room and published device. */
export function createRoomSendRoutes(input: Readonly<{
  store: ControlStore;
  auth: Pick<AuthService, 'requireHumanMutation'>;
  capabilities: Pick<AdapterCapabilities, 'authorize'>;
  inspectOwnerMembership(ownerId: AuthPrincipal['ownerId'], roomId: RoomId): Promise<Readonly<{ kind: 'joined' | 'absent' | 'unavailable' }>>;
  verifyBrowserSender: BrowserSenderVerifier;
  agentSender(binding: SessionBinding): Promise<Readonly<{ matrixUserId: string; deviceKey: string }> | null>;
  diagnostic?: RoomSendDiagnostic;
}>): readonly RouteRegistration[] {
  const fence = createRoomSendFence(input.store);
  const ownerRooms = createOwnerRoomIndex(input.store);
  const unavailable = (stage: RoomSendFailureStage, code: RoomSendFailureCode) => {
    try { input.diagnostic?.({ stage, code }); } catch { /* Diagnostics never affect authorization. */ }
    return json(503, { kind: 'unavailable', stage, code });
  };
  async function principal(request: Request, human: boolean, body: Record<string, unknown>, action: Action): Promise<Principal | Response> {
    if (human) {
      let auth: Awaited<ReturnType<typeof input.auth.requireHumanMutation>>;
      try { auth = await input.auth.requireHumanMutation(request); }
      catch { return unavailable('auth', 'session_store_unavailable'); }
      if (auth.kind !== 'authorized') return auth.kind === 'unavailable'
        ? unavailable('auth', 'session_store_unavailable') : json(403, { code: 'forbidden' });
      const room = decodeRoomId(body.roomId);
      if (!room.ok || !ID.test(String(body.deviceId))) return json(400, { code: 'invalid_request' });
      let membership: Awaited<ReturnType<typeof input.inspectOwnerMembership>>;
      try { membership = await input.inspectOwnerMembership(auth.context.principal.ownerId, room.value); }
      catch { return unavailable('membership', 'matrix_unavailable'); }
      if (membership.kind !== 'joined') return membership.kind === 'unavailable'
        ? unavailable('membership', 'matrix_unavailable') : json(403, { code: 'forbidden' });
      let verified: Awaited<ReturnType<BrowserSenderVerifier>>;
      try { verified = await input.verifyBrowserSender(auth.context.principal, body.deviceId as string,
        body.matrixAccessToken as string); }
      catch { return unavailable('sender', 'sender_verification_unavailable'); }
      if (!verified) return json(403, { code: 'device_unverified' });
      return { roomId: room.value, sender: { senderId: senderIdFor(verified.matrixUserId, body.deviceId as string),
        deviceId: body.deviceId as string, deviceKey: verified.deviceKey } };
    }
    let checked: Awaited<ReturnType<typeof input.capabilities.authorize>>;
    try { checked = await input.capabilities.authorize(request, 'publish_own'); }
    catch { return unavailable('auth', 'session_store_unavailable'); }
    if (checked.kind !== 'authorized') return json(checked.kind === 'unavailable' ? 503 : checked.status,
      { code: checked.kind === 'unavailable' ? 'unavailable' : checked.code });
    if (action === 'acquire') {
      let membership: Awaited<ReturnType<typeof input.inspectOwnerMembership>>;
      try { membership = await input.inspectOwnerMembership(checked.ownerId, checked.roomId); }
      catch { return unavailable('membership', 'matrix_unavailable'); }
      if (membership.kind !== 'joined') return membership.kind === 'unavailable'
        ? unavailable('membership', 'matrix_unavailable') : json(403, { code: 'owner_membership_required' });
      let indexed: Awaited<ReturnType<typeof ownerRooms.inspect>>;
      try { indexed = await ownerRooms.inspect(checked.ownerId, checked.roomId); }
      catch { return unavailable('auth', 'session_store_unavailable'); }
      if (indexed.kind !== 'ok') return unavailable('auth', 'session_store_unavailable');
      if (indexed.value?.marker) return json(403, { code: 'channel_closing' });
      if (!indexed.value?.bindings.some(item => item.bindingId === checked.binding.bindingId
        && item.generation === checked.binding.generation)) return json(403, { code: 'binding_superseded' });
    }
    let verified: Awaited<ReturnType<typeof input.agentSender>>;
    try { verified = await input.agentSender(checked.binding); }
    catch { return unavailable('sender', 'sender_verification_unavailable'); }
    if (!verified) return json(503, { code: 'unavailable' });
    return { roomId: checked.roomId, sender: { senderId: senderIdFor(verified.matrixUserId, checked.binding.deviceId),
      deviceId: checked.binding.deviceId, deviceKey: verified.deviceKey } };
  }
  const route = (human: boolean, action: Action): RouteRegistration => Object.freeze({
    path: `${human ? HUMAN : AGENT}/${action}`, methods: ['POST'],
    async handle(request) {
      if ((request.headers.get('content-type') ?? '').split(';')[0]?.trim() !== 'application/json') return json(400, { code: 'invalid_request' });
      let body: unknown;
      try { body = await request.json(); } catch { return json(400, { code: 'invalid_request' }); }
      if (!validBody(body, human, action)) return json(400, { code: 'invalid_request' });
      const selected = await principal(request, human, body, action);
      if (selected instanceof Response) return selected;
      const { roomId, sender } = selected;
      switch (action) {
        case 'ready': {
          const result = await fence.readySender(roomId, sender);
          return json(result === 'applied' ? 200 : result === 'held' ? 423 : 503, { kind: result });
        }
        case 'acquire': {
          let result: Awaited<ReturnType<typeof fence.acquire>>;
          try { result = await fence.acquire(roomId, sender, body.clientTxnId as string, !human); }
          catch { return unavailable('fence_acquire', 'fence_unavailable'); }
          return result.kind === 'unavailable' ? unavailable('fence_acquire', 'fence_unavailable')
            : json(result.kind === 'granted' ? 200 : 423, result);
        }
        case 'finish': {
          const outcome = body.outcome === 'complete' ? { kind: 'complete' as const, eventId: body.eventId as string }
            : { kind: body.outcome as 'unknown' | 'cancelled' };
          const result = await fence.finish(roomId, sender.senderId, body.permitId as string, outcome,
            human ? 0 : body.attempt === undefined ? 0 : body.attempt as number);
          return json(result === 'applied' ? 200 : 503, { kind: result });
        }
        case 'rotation': {
          const result = await fence.acknowledgeRotation(roomId, sender, body.operationId as string, body.epoch as number);
          return json(result === 'applied' ? 200 : 503, { kind: result });
        }
        case 'inspect': {
          const result = await fence.inspect(roomId);
          if (result.kind !== 'found') return json(503, { kind: 'unavailable' });
          return json(200, { kind: 'ok', epoch: result.value.epoch,
            hold: result.value.hold ? { operationId: result.value.hold.operationId, epoch: result.value.hold.epoch } : null });
        }
      }
    },
  });
  return Object.freeze([...ACTIONS.map(action => route(true, action)), ...ACTIONS.map(action => route(false, action))]);
}

export function createLazyRoomSendRoutes(load: () => readonly RouteRegistration[], diagnostic?: RoomSendDiagnostic): readonly RouteRegistration[] {
  return Object.freeze([HUMAN, AGENT].flatMap(base => ACTIONS.map(action => Object.freeze({
    path: `${base}/${action}`, methods: Object.freeze(['POST']), async handle(request: Request) {
      let selected: RouteRegistration | undefined;
      try { selected = load().find(route => route.path === `${base}/${action}`); }
      catch {
        try { diagnostic?.({ stage: 'composition', code: 'load_failed' }); } catch { /* diagnostic only */ }
        return json(503, { kind: 'unavailable', stage: 'composition', code: 'load_failed' });
      }
      if (selected) {
        try { return await selected.handle(request); }
        catch {
          try { diagnostic?.({ stage: 'composition', code: 'handle_failed' }); } catch { /* diagnostic only */ }
          return json(503, { kind: 'unavailable', stage: 'composition', code: 'handle_failed' });
        }
      }
      try { diagnostic?.({ stage: 'composition', code: 'route_missing' }); } catch { /* diagnostic only */ }
      return json(503, { kind: 'unavailable', stage: 'composition', code: 'route_missing' });
    },
  }))));
}
