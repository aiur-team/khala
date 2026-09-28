import { decodeRoomId, type AuthPrincipal, type ControlStore, type OwnerId, type RoomId } from '@khala/contracts/messaging/index';
import type { AuthService } from '../../auth/index';
import type { RouteRegistration } from '../../runtime/handler';
import { createDeviceAdmission, type Replacement } from './device-admission';
import type { BrowserSenderVerifier } from './room-send-routes';

export const DEVICE_ADMISSION_PATH = '/api/human/devices/replacement';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
type Action = 'reserve' | 'activate' | 'revoke';
type Binding = Readonly<{ ownerId: OwnerId; roomId: RoomId; deviceId: string; deviceKey: string;
  generation: number; policyDigest: string }>;

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: {
    'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  } });
}
function body(value: unknown): value is { action: Action; operationId: string; roomId: string;
  deviceId: string; matrixAccessToken: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).sort().join(',') === 'action,deviceId,matrixAccessToken,operationId,roomId'
    && ['reserve', 'activate', 'revoke'].includes(String(row.action))
    && typeof row.operationId === 'string' && ID.test(row.operationId)
    && typeof row.roomId === 'string' && decodeRoomId(row.roomId).ok
    && typeof row.deviceId === 'string' && ID.test(row.deviceId)
    && typeof row.matrixAccessToken === 'string' && row.matrixAccessToken.length >= 16
    && row.matrixAccessToken.length <= 4096;
}

/**
 * A server-side binding resolver must prove the original admission and policy,
 * and assign the new device generation. Browser fields are selectors only.
 */
export type ReplacementBindingResolver = (principal: AuthPrincipal, roomId: RoomId,
  deviceId: string) => Promise<Binding | null>;

export function createDeviceAdmissionRoutes(input: Readonly<{
  store: ControlStore;
  auth: Pick<AuthService, 'requireHumanMutation'>;
  verifyBrowserSender: BrowserSenderVerifier;
  bindingFor: ReplacementBindingResolver;
  authorize(principal: AuthPrincipal, request: Replacement): Promise<'authorized' | 'refused' | 'unavailable'>;
  currentPosition(roomId: RoomId): Promise<number | null>;
  distributionReady(request: Replacement): Promise<boolean>;
}>): readonly RouteRegistration[] {
  // The ledger's callback is request-scoped: no ambient principal or client-supplied authority.
  const route: RouteRegistration = Object.freeze({
    path: DEVICE_ADMISSION_PATH, methods: ['POST'],
    async handle(request) {
      const signed = await input.auth.requireHumanMutation(request).catch(() => ({ kind: 'unavailable' as const }));
      if (signed.kind === 'unavailable') return json(503, { code: 'unavailable' });
      if (signed.kind !== 'authorized') return json(signed.code === 'signed_out' ? 401 : 403, { code: 'forbidden' });
      if ((request.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        return json(400, { code: 'invalid_request' });
      }
      let parsed: unknown;
      try { parsed = await request.json(); } catch { return json(400, { code: 'invalid_request' }); }
      if (!body(parsed)) return json(400, { code: 'invalid_request' });
      const room = decodeRoomId(parsed.roomId);
      if (!room.ok) return json(400, { code: 'invalid_request' });
      const { principal } = signed.context;
      const verified = await input.verifyBrowserSender(principal, parsed.deviceId, parsed.matrixAccessToken)
        .catch(() => null);
      if (!verified) return json(403, { code: 'device_unverified' });
      const binding = await input.bindingFor(principal, room.value, parsed.deviceId).catch(() => null);
      if (!binding) return json(403, { code: 'binding_unavailable' });
      if (binding.ownerId !== principal.ownerId || binding.roomId !== room.value
        || binding.deviceId !== parsed.deviceId || binding.deviceKey !== verified.deviceKey
        || !Number.isSafeInteger(binding.generation) || binding.generation < 0
        || !/^[a-f0-9]{64}$/u.test(binding.policyDigest)) return json(403, { code: 'binding_mismatch' });
      const replacement: Replacement = { ...binding, operationId: parsed.operationId };
      const ledger = createDeviceAdmission({ store: input.store,
        authorize: candidate => input.authorize(principal, candidate),
        currentPosition: input.currentPosition,
        // This command route never serves reads. No trusted event-position source
        // is composed, so the ledger's read predicate must fail closed here.
        positionFor: async () => null,
        distributionReady: input.distributionReady });
      // Recheck authority inside the ledger on every reserve/activate/revoke retry.
      const result = await ledger[parsed.action](replacement).catch(() => 'unavailable' as const);
      return json(result === 'applied' ? 200 : result === 'pending' ? 202
        : result === 'conflict' ? 409 : result === 'refused' ? 403 : 503, { kind: result });
    },
  });
  return Object.freeze([route]);
}

export function createLazyDeviceAdmissionRoutes(load: () => readonly RouteRegistration[]): readonly RouteRegistration[] {
  return Object.freeze([Object.freeze({ path: DEVICE_ADMISSION_PATH, methods: Object.freeze(['POST']),
    async handle(request: Request) {
      const selected = load().find(route => route.path === DEVICE_ADMISSION_PATH);
      return selected ? selected.handle(request) : json(503, { code: 'feature_unavailable' });
    } })]);
}
