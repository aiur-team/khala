import {
  decodeBindingId, decodeRevocationRequest, decodeRoomId,
  type AuthPrincipal, type ControlStore, type OwnerId, type RoomId, type SessionBinding,
} from '@khala/contracts/messaging/index';
import { createRevocationService, type ProtocolRevocationPort } from '@khala/messaging/revocation/index';
import { operationJournal } from '@khala/messaging/revocation/journal';
import type { AuthService } from '../../auth/index';
import type { AdapterCapabilities } from '../../agent-bootstrap/handler';
import { createAgentBindingStore } from '../../agent-bootstrap/store';
import { createOwnerRoomIndex } from '../../agent-bootstrap/owner-room-index';
import type { RouteRegistration } from '../../runtime/handler';
import { createRevocationCleanupStore } from './revocation-cleanup';
import { createRoomSendFence } from './room-send-fence';

export const REVOCATION_TARGETS_PATH = '/api/human/revocation/targets';
export const REVOCATION_REVOKE_PATH = '/api/human/revocation/revoke';
export const REVOCATION_STATUS_PATH = '/api/human/revocation/status';

type Membership = (ownerId: OwnerId, roomId: RoomId) => Promise<Readonly<{ kind: 'joined' | 'absent' | 'unavailable' }>>;

export type OwnerRevocationDependencies = Readonly<{
  auth: Pick<AuthService, 'authenticateRequest' | 'requireHumanMutation'>;
  store: ControlStore;
  capabilities: Pick<AdapterCapabilities, 'lookupBinding' | 'disableBinding' | 'revokeAdapterCapability'>;
  /** Public Curve25519 identity key from the selected Matrix account's exact device query. */
  deviceIdentityKey(binding: SessionBinding): Promise<string | null>;
  inspectOwnerMembership: Membership;
  /** A real trusted endpoint adapter. No server process can claim an SDK effect on its behalf. */
  protocolFor(ownerId: OwnerId): ProtocolRevocationPort;
}>;

const headers = { 'cache-control': 'no-store', 'content-type': 'application/json', 'x-content-type-options': 'nosniff' };
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
function json(status: number, body: unknown): Response { return new Response(JSON.stringify(body), { status, headers }); }
function plain(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

/** The owner-scoped HTTP surface around KHA-128's durable operation journal. */
export function createOwnerRevocationRoutes(input: OwnerRevocationDependencies): readonly RouteRegistration[] {
  const bindings = createAgentBindingStore({ store: input.store });
  const rooms = createOwnerRoomIndex(input.store);
  const cleanup = createRevocationCleanupStore(input.store);
  const sendFence = createRoomSendFence(input.store);
  async function owner(request: Request, mutation: boolean): Promise<AuthPrincipal | Response> {
    const result = mutation ? await input.auth.requireHumanMutation(request) : await input.auth.authenticateRequest(request);
    if (result.kind === 'unavailable') return json(503, { code: 'unavailable' });
    if (result.kind === 'authenticated' || result.kind === 'authorized') return result.context.principal;
    return json(result.kind === 'signed_out' || ('code' in result && result.code === 'signed_out') ? 401 : 403,
      { code: 'owner_auth_required' });
  }
  async function service(principal: AuthPrincipal) {
    return createRevocationService({
      principal, journal: input.store, protocol: input.protocolFor(principal.ownerId),
      targets: {
        async lookup(subject) {
          if (subject.targetKind !== 'binding') return { kind: 'absent' };
          const located = await bindings.locateBinding(subject.targetId);
          if (located.kind !== 'found') return located;
          const binding = located.record.binding;
          if (binding.ownerId !== principal.ownerId) return { kind: 'absent' };
          const member = await input.inspectOwnerMembership(principal.ownerId, located.address.roomId);
          if (member.kind === 'unavailable') return { kind: 'unavailable' };
          if (member.kind !== 'joined') return { kind: 'absent' };
          const key = await input.deviceIdentityKey(binding);
          if (key === null || !/^[A-Za-z0-9+/]{43}=?$/u.test(key)) return { kind: 'unavailable' };
          return { kind: 'found', ownerId: binding.ownerId,
            generation: located.record.revokedGeneration ?? binding.generation,
            device: { deviceId: binding.deviceId, deviceKey: key } };
        },
      },
      control: {
        async disable(subject) {
          if (subject.targetKind !== 'binding') return { kind: 'unavailable' };
          const intent = await operationJournal(principal.ownerId, input.store).load(subject.operationId);
          if (intent.kind !== 'found' || intent.stored.record.targetKind !== 'binding'
            || intent.stored.record.targetId !== subject.targetId
            || intent.stored.record.expectedGeneration !== subject.expectedGeneration
            || intent.stored.record.revokedGeneration !== subject.revokedGeneration) return { kind: 'unavailable' };
          const located = await bindings.locateBinding(subject.targetId);
          if (located.kind !== 'found' || located.record.binding.ownerId !== principal.ownerId
            || located.record.binding.deviceId !== intent.stored.record.deviceId) return { kind: 'unavailable' };
          // The hold is durable before control disable and before the first SDK protocol call.
          // A send with an unknown Matrix outcome keeps the operation pending until its
          // original transaction ID is reconciled; a timeout cannot establish safety.
          if (await sendFence.beginHold(located.address.roomId, subject.operationId,
            intent.stored.record.deviceKey) !== 'held') return { kind: 'unavailable' };
          if (await sendFence.drained(located.address.roomId, subject.operationId) !== 'drained') {
            return { kind: 'unavailable' };
          }
          const prepared = await cleanup.prepare({ ownerId: principal.ownerId, operationId: subject.operationId,
            bindingId: subject.targetId, deviceId: intent.stored.record.deviceId,
            deviceKey: intent.stored.record.deviceKey, expectedGeneration: subject.expectedGeneration,
            revokedGeneration: subject.revokedGeneration, capabilityDigest: located.record.capability });
          if (prepared !== 'applied') return { kind: 'unavailable' };
          return input.capabilities.disableBinding({ ...subject, bindingId: subject.targetId });
        },
        revokeAdapterCapability: subject => input.capabilities.revokeAdapterCapability(subject),
      },
    });
  }
  return Object.freeze([
    {
      path: REVOCATION_TARGETS_PATH, methods: ['GET'],
      async handle(request) {
        const principal = await owner(request, false);
        if (principal instanceof Response) return principal;
        const search = new URL(request.url).searchParams;
        if ([...search.keys()].join(',') !== 'roomId') return json(400, { code: 'invalid_request' });
        const room = decodeRoomId(search.get('roomId'));
        if (!room.ok) return json(400, { code: 'invalid_request' });
        const membership = await input.inspectOwnerMembership(principal.ownerId, room.value);
        if (membership.kind === 'unavailable') return json(503, { code: 'unavailable' });
        if (membership.kind !== 'joined') return json(403, { code: 'forbidden' });
        const indexed = await rooms.inspect(principal.ownerId, room.value);
        if (indexed.kind !== 'ok') return json(503, { code: 'unavailable' });
        if (!indexed.value) return json(200, { targets: [] });
        const targets = [];
        for (const item of indexed.value.bindings) {
          const bindingId = decodeBindingId(item.bindingId);
          if (!bindingId.ok) return json(503, { code: 'unavailable' });
          const located = await bindings.locateBinding(bindingId.value);
          if (located.kind !== 'found' || located.address.roomId !== room.value
            || located.record.binding.ownerId !== principal.ownerId) return json(503, { code: 'unavailable' });
          if (located.record.revokedGeneration === null && located.record.binding.generation === item.generation) {
            targets.push({ targetKind: 'binding', targetId: bindingId.value, expectedGeneration: item.generation });
          }
        }
        return json(200, { targets });
      },
    },
    {
      path: REVOCATION_REVOKE_PATH, methods: ['POST'],
      async handle(request) {
        const principal = await owner(request, true);
        if (principal instanceof Response) return principal;
        if ((request.headers.get('content-type') ?? '').split(';')[0]?.trim() !== 'application/json') return json(400, { code: 'invalid_request' });
        let raw: unknown;
        try { raw = await request.json(); } catch { return json(400, { code: 'invalid_request' }); }
        const decoded = decodeRevocationRequest(raw);
        if (!decoded.ok || decoded.value.targetKind !== 'binding') return json(400, { code: 'invalid_request' });
        const result = await (await service(principal)).revoke(decoded.value);
        return json(result.kind === 'ok' ? 200 : result.kind === 'rejected'
          ? result.code === 'forbidden' ? 403 : result.code === 'not_found' ? 404 : 409
          : result.kind === 'outcome_unknown' ? 502 : 503, result);
      },
    },
    {
      path: REVOCATION_STATUS_PATH, methods: ['GET'],
      async handle(request) {
        const principal = await owner(request, false);
        if (principal instanceof Response) return principal;
        const search = new URL(request.url).searchParams;
        const operationId = search.get('operationId');
        if ([...search.keys()].join(',') !== 'operationId' || !operationId || !IDENTIFIER.test(operationId)) {
          return json(400, { code: 'invalid_request' });
        }
        const result = await (await service(principal)).status(operationId);
        return json(result.kind === 'ok' ? 200 : result.kind === 'rejected' ? 404 : 503, result);
      },
    },
  ]);
}

/** Fixed build-time route inventory; production adapters are constructed on the request. */
export function createLazyOwnerRevocationRoutes(load: () => readonly RouteRegistration[]): readonly RouteRegistration[] {
  const route = (path: string, methods: readonly string[]): RouteRegistration => ({ path, methods,
    async handle(request) {
      const registration = load().find(item => item.path === path);
      if (!registration) return json(503, { code: 'unavailable' });
      return registration.handle(request);
    },
  });
  return Object.freeze([
    route(REVOCATION_TARGETS_PATH, ['GET']), route(REVOCATION_REVOKE_PATH, ['POST']), route(REVOCATION_STATUS_PATH, ['GET']),
  ]);
}
