import { createHash, randomBytes } from 'node:crypto';
import type { ControlStore, JsonValue, SessionBinding } from '@khala/contracts/messaging/index';
import type { AdapterCapabilities, AdapterAuthorization } from '../../agent-bootstrap/handler';
import { checkProof, proofKeyThumbprint } from '../../agent-bootstrap/proof';
import type { RouteRegistration } from '../../runtime/handler';

export const DEVICE_CHALLENGE_PATH = '/api/agent/device-attestation/challenge';
export const DEVICE_REGISTER_PATH = '/api/agent/device-attestation/register';
const CHALLENGE_TTL_MS = 60_000;
const NONCE = /^[A-Za-z0-9_-]{43}$/u;
const FINGERPRINT = /^[A-Za-z0-9+/]{43}=?$/u;

export type DeviceAttestation = Readonly<{
  v: 1; ownerId: string; roomId: string; bindingId: string; deviceId: string;
  generation: number; fingerprint: string;
}>;
export type DeviceAttestationLookup = Readonly<{ kind: 'found'; attestation: DeviceAttestation }>
  | Readonly<{ kind: 'absent' | 'unavailable' }>;

export type DeviceAttestationDependencies = Readonly<{
  origin: string;
  allowInsecureLoopback?: boolean;
  store: ControlStore;
  capabilities: Pick<AdapterCapabilities, 'authorize' | 'lookupBinding'>;
  publishedFingerprint(binding: SessionBinding): Promise<string | null>;
  clock: () => number;
  random?: (bytes: number) => Uint8Array;
}>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}

function key(kind: 'challenge' | 'attestation', value: string): string {
  return `agent-device.${kind}.v1.${createHash('sha256').update(value).digest('hex')}`;
}

/** The endpoint signs this exact digest in its DPoP proof's `body_hash` claim. */
export function attestationBodyHash(input: Readonly<{
  v: 1; bindingId: string; deviceId: string; generation: number; nonce: string; fingerprint: string;
}>): string {
  return createHash('sha256').update(JSON.stringify({
    v: input.v, bindingId: input.bindingId, deviceId: input.deviceId,
    generation: input.generation, nonce: input.nonce, fingerprint: input.fingerprint,
  })).digest('base64url');
}

function refusal(auth: Exclude<AdapterAuthorization, { kind: 'authorized' }>): Response {
  return auth.kind === 'unavailable'
    ? json(503, { code: 'unavailable' })
    : json(auth.status, { code: auth.code });
}

function parseBody(value: unknown): Readonly<{
  v: 1; bindingId: string; deviceId: string; generation: number; nonce: string; fingerprint: string;
}> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).sort().join(',') !== 'bindingId,deviceId,fingerprint,generation,nonce,v'
    || body.v !== 1 || typeof body.bindingId !== 'string' || typeof body.deviceId !== 'string'
    || !Number.isSafeInteger(body.generation) || typeof body.nonce !== 'string' || !NONCE.test(body.nonce)
    || typeof body.fingerprint !== 'string' || !FINGERPRINT.test(body.fingerprint)) return null;
  return body as ReturnType<typeof parseBody> & {};
}

/**
 * Proof-bound post-activation registration. A Matrix device list is never a
 * trust source by itself: the connector signs a one-use challenge and exact
 * body, the server compares the key to Matrix's published key, and the record
 * remains usable only while the original binding generation is active.
 */
export function createDeviceAttestationRoutes(deps: DeviceAttestationDependencies): Readonly<{
  agent: readonly RouteRegistration[];
  lookup(binding: SessionBinding): Promise<DeviceAttestation | null>;
  lookupState(binding: SessionBinding): Promise<DeviceAttestationLookup>;
}> {
  const origin = new URL(deps.origin);
  const loopback = deps.allowInsecureLoopback === true && origin.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (!(origin.protocol === 'https:' || loopback) || origin.origin !== deps.origin) throw new Error('attestation origin must be exact HTTPS');

  async function active(binding: SessionBinding): Promise<boolean> {
    const result = await deps.capabilities.lookupBinding(binding.bindingId);
    return result.kind === 'found' && result.status === 'active'
      && result.ownerId === binding.ownerId && result.deviceId === binding.deviceId
      && result.generation === binding.generation;
  }

  async function challenge(request: Request): Promise<Response> {
    const auth = await deps.capabilities.authorize(request, 'publish_own');
    if (auth.kind !== 'authorized') return refusal(auth);
    if (!await active(auth.binding)) return json(403, { code: 'binding_inactive' });
    const nonce = Buffer.from((deps.random ?? randomBytes)(32)).toString('base64url');
    const created = await deps.store.compareAndSet<JsonValue>({
      key: key('challenge', nonce), expectedRevision: null, operationId: `device.challenge.${nonce}`,
      next: { value: {
        v: 1, ownerId: auth.ownerId, bindingId: auth.binding.bindingId,
        deviceId: auth.binding.deviceId, generation: auth.binding.generation, used: false,
      }, expiresAt: new Date(deps.clock() + CHALLENGE_TTL_MS).toISOString() },
    });
    return created.kind === 'applied' ? json(200, { v: 1, nonce, expiresAt: deps.clock() + CHALLENGE_TTL_MS })
      : json(503, { code: 'unavailable' });
  }

  async function register(request: Request): Promise<Response> {
    const auth = await deps.capabilities.authorize(request, 'publish_own');
    if (auth.kind !== 'authorized') return refusal(auth);
    let body: ReturnType<typeof parseBody> = null;
    try { body = parseBody(await request.json()); } catch { /* invalid request */ }
    if (!body) return json(400, { code: 'invalid_request' });
    const binding = auth.binding;
    if (body.bindingId !== binding.bindingId || body.deviceId !== binding.deviceId || body.generation !== binding.generation) {
      return json(403, { code: 'binding_mismatch' });
    }
    const accessToken = request.headers.get('authorization')?.match(/^DPoP ([A-Za-z0-9_-]+)$/u)?.[1];
    const proof = request.headers.get('dpop');
    const jkt = proofKeyThumbprint(proof);
    const signed = accessToken && jkt ? checkProof(proof, {
      method: 'POST', url: `${deps.origin}${DEVICE_REGISTER_PATH}`, jkt,
      accessToken, nowMs: deps.clock(), nonce: body.nonce, bodyHash: attestationBodyHash(body),
    }) : null;
    if (!signed || signed.kind !== 'valid') return json(401, { code: 'invalid_proof' });
    const challengeKey = key('challenge', body.nonce);
    const held = await deps.store.read(challengeKey);
    if (held.kind !== 'record') return json(403, { code: 'challenge_unavailable' });
    const rawExpected = held.record.value;
    if (typeof rawExpected !== 'object' || rawExpected === null || Array.isArray(rawExpected)) return json(503, { code: 'unavailable' });
    const expected = rawExpected as Record<string, JsonValue>;
    if (expected.v !== 1 || expected.used !== false || expected.ownerId !== auth.ownerId
      || expected.bindingId !== binding.bindingId || expected.deviceId !== binding.deviceId
      || expected.generation !== binding.generation) return json(403, { code: 'challenge_mismatch' });
    const consumed = await deps.store.compareAndSet<JsonValue>({
      key: challengeKey, expectedRevision: held.record.revision,
      operationId: `device.consume.${body.nonce}.${signed.jti}`,
      next: { value: { ...expected, used: true }, expiresAt: held.record.expiresAt },
    });
    if (consumed.kind !== 'applied') return json(403, { code: 'challenge_replayed' });
    if (!await active(binding)) return json(403, { code: 'binding_inactive' });
    const published = await deps.publishedFingerprint(binding);
    if (published === null) return json(503, { code: 'device_key_unavailable' });
    if (published !== body.fingerprint) return json(403, { code: 'fingerprint_mismatch' });
    const attestation: DeviceAttestation = {
      v: 1, ownerId: auth.ownerId, roomId: auth.roomId, bindingId: binding.bindingId,
      deviceId: binding.deviceId, generation: binding.generation, fingerprint: published,
    };
    const attestationKey = key('attestation', binding.bindingId);
    const saved = await deps.store.compareAndSet<JsonValue>({
      key: attestationKey, expectedRevision: null,
      operationId: `device.attest.${binding.bindingId}.${binding.generation}.${createHash('sha256').update(published).digest('hex')}`,
      next: { value: attestation, expiresAt: null },
    });
    if (saved.kind === 'applied') return json(200, { v: 1, kind: 'attested' });
    if (saved.kind === 'conflict' && saved.current && JSON.stringify(saved.current.value) === JSON.stringify(attestation)) {
      return json(200, { v: 1, kind: 'attested' });
    }
    return saved.kind === 'conflict' ? json(409, { code: 'key_replacement_refused' }) : json(503, { code: 'unavailable' });
  }

  async function lookupState(binding: SessionBinding): Promise<DeviceAttestationLookup> {
    const current = await deps.capabilities.lookupBinding(binding.bindingId);
    if (current.kind === 'unavailable') return { kind: 'unavailable' };
    if (current.kind !== 'found' || current.status !== 'active' || current.ownerId !== binding.ownerId
      || current.deviceId !== binding.deviceId || current.generation !== binding.generation) return { kind: 'absent' };
    const record = await deps.store.read(key('attestation', binding.bindingId));
    if (record.kind === 'unavailable') return { kind: 'unavailable' };
    if (record.kind !== 'record') return { kind: 'absent' };
    const value = record.record.value as unknown as DeviceAttestation;
    return value && value.v === 1 && value.ownerId === binding.ownerId && value.bindingId === binding.bindingId
      && value.deviceId === binding.deviceId && value.generation === binding.generation && FINGERPRINT.test(value.fingerprint)
      ? { kind: 'found', attestation: value } : { kind: 'unavailable' };
  }

  async function lookup(binding: SessionBinding): Promise<DeviceAttestation | null> {
    const result = await lookupState(binding);
    return result.kind === 'found' ? result.attestation : null;
  }

  return {
    agent: Object.freeze([
      { path: DEVICE_CHALLENGE_PATH, methods: ['GET'], handle: challenge },
      { path: DEVICE_REGISTER_PATH, methods: ['POST'], handle: register },
    ]),
    lookup,
    lookupState,
  };
}

/** Static gateway metadata, with live capability and store resolved per request. */
export function createLazyDeviceAttestationRoutes(
  load: (request: Request) => ReturnType<typeof createDeviceAttestationRoutes> | Promise<ReturnType<typeof createDeviceAttestationRoutes>>,
): readonly RouteRegistration[] {
  return Object.freeze([
    { path: DEVICE_CHALLENGE_PATH, methods: ['GET'], async handle(request: Request) {
      const routes = await load(request);
      return routes.agent[0]!.handle(request);
    } },
    { path: DEVICE_REGISTER_PATH, methods: ['POST'], async handle(request: Request) {
      const routes = await load(request);
      return routes.agent[1]!.handle(request);
    } },
  ]);
}
