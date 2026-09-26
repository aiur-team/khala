// Provider-neutral channel discovery and request contracts. Agent-facing ports
// can enumerate or journal a human decision; they cannot create channels, admit
// members, or expose provider identifiers.

import {
  type Decoded,
  array,
  decodeWith,
  elementPath,
  fail,
  identifier,
  isWellFormed,
  literal,
  nullable,
  object,
  safeInteger,
  utf8Length,
  utcTimestamp,
  version,
} from './decode';
import type { AuthPrincipal } from './identity';
import { type DeviceId, type OwnerId, readId } from './ids';
import type { CallOptions, OperationResult } from './outcomes';
import { readCanonicalOrigin } from './pairing';

export const MAX_CHANNEL_TITLE_BYTES = 256;
export const MAX_CHANNEL_LIST_PAGE_SIZE = 25;
export const MAX_CHANNEL_URL_BYTES = 2048;
export const MAX_SEALED_GRANT_BYTES = 16_384;

export const CHANNEL_DISCOVERY_SCOPES = [
  'list_channels',
  'request_channel_access',
  'request_channel_create',
] as const;

export const ACCESS_REQUEST_OUTCOMES = [
  'pending_owner',
  'approved',
  'connecting',
  'connected',
  'repair_required',
  'denied',
  'expired',
  'revoked',
  'unavailable',
] as const;

export const CHANNEL_CREATE_OUTCOMES = [
  'pending',
  'created',
  'already_created',
  'denied',
  'outcome_unknown',
  'unavailable',
] as const;

/** Libsodium sealed boxes: X25519 plus XSalsa20-Poly1305. */
export const CHANNEL_SEALED_BOX_ALGORITHM = 'crypto_box_seal_x25519_xsalsa20poly1305' as const;
/** Lifetime of the one-time grant inside a sealed envelope, from sealing. */
export const CHANNEL_ACCESS_GRANT_LIFETIME_MS = 15 * 60_000;
/** Hard recovery expiry of a stored envelope and of an admitted operation, from sealing. */
export const CHANNEL_ACCESS_ENVELOPE_RECOVERY_MS = 7 * 24 * 60 * 60_000;

export type ChannelVisibility = 'public' | 'private' | 'secret';
export type ChannelServiceKind = 'internal' | 'external';
export type AccessRequestOutcome = (typeof ACCESS_REQUEST_OUTCOMES)[number];
export type ChannelCreateOutcome = (typeof CHANNEL_CREATE_OUTCOMES)[number];
export type DiscoveryScope = (typeof CHANNEL_DISCOVERY_SCOPES)[number];

/** Stable within one owner; never a display name, device ID, or session ID. */
export type StableAgentPrincipal = string & { readonly __khala: 'StableAgentPrincipal' };

/** Opaque server-only channel reference, never a Matrix room ID. */
export type AuthorizedChannelRef = string & { readonly __khala: 'AuthorizedChannelRef' };

export type Ed25519ProofKey = Readonly<{
  algorithm: 'Ed25519';
  /** Unpadded base64url, exactly 32 bytes. */
  publicKey: string;
  /** RFC 7638 SHA-256 OKP thumbprint, unpadded base64url. */
  thumbprint: string;
}>;

export type X25519EncryptionKey = Readonly<{
  algorithm: 'X25519';
  /** Unpadded base64url, exactly 32 bytes. Distinct from the proof key. */
  publicKey: string;
  /** RFC 7638 SHA-256 OKP thumbprint, unpadded base64url. */
  thumbprint: string;
}>;

export type DiscoveryRequester = Readonly<{
  principal: StableAgentPrincipal;
  origin: string;
  proofKey: Ed25519ProofKey;
  sessionGeneration: number;
}>;

export type DiscoveryCredential = Readonly<{
  v: 1;
  credentialRef: string;
  audience: 'khala-channel-discovery';
  requester: DiscoveryRequester;
  /** Exactly the three request-only scopes; never approve, create, or admit. */
  scopes: typeof CHANNEL_DISCOVERY_SCOPES;
  expiresAt: string;
}>;

export type ChannelListing = Readonly<{
  v: 1;
  listingRef: string;
  /** Bounded owner-controlled data. Unsafe controls are replaced with U+FFFD. */
  title: string;
  visibility: ChannelVisibility;
  serviceKind: ChannelServiceKind;
  requestState: 'not_requested' | AccessRequestOutcome;
}>;

export type ChannelListingPage = Readonly<{
  v: 1;
  items: readonly ChannelListing[];
  /** Opaque snapshot cursor; no total count is exposed. */
  nextCursor: string | null;
}>;

export type ChannelListQuery = Readonly<{
  v: 1;
  cursor: string | null;
  limit: number;
}>;

export type ListingRefAccessRequest = Readonly<{
  v: 1;
  kind: 'listing_ref';
  operationId: string;
  credentialRef: string;
  listingRef: string;
}>;

export type ChannelUrlAccessRequest = Readonly<{
  v: 1;
  kind: 'channel_url';
  operationId: string;
  credentialRef: string;
  /** Canonical, exact-origin URL; it is a locator, never admission authority. */
  channelUrl: string;
}>;

export type ChannelAccessRequest = ListingRefAccessRequest | ChannelUrlAccessRequest;

export type AccessRequestStatus = Readonly<{
  v: 1;
  operationId: string;
  /** Grant-free status. Approval is durable authorization, not a credential. */
  outcome: AccessRequestOutcome;
}>;

export type ChannelCreateIntent = Readonly<{
  v: 1;
  operationId: string;
  credentialRef: string;
  origin: string;
  /** Bounded untrusted proposal data; this type carries no create authority. */
  proposedTitle: string;
}>;

export type GrantExchangeRequest = Readonly<{
  v: 1;
  operationId: string;
  requester: StableAgentPrincipal;
  origin: string;
  proofKey: Ed25519ProofKey;
  encryptionKey: X25519EncryptionKey;
  deviceId: DeviceId;
  sessionGeneration: number;
  expiresAt: string;
}>;

export type GrantExchangeBinding = Readonly<{
  encryptionKeyPublicKey: string;
  encryptionKeyThumbprint: string;
  proofKeyThumbprint: string;
  operationId: string;
  deviceId: DeviceId;
  requester: StableAgentPrincipal;
  origin: string;
  sessionGeneration: number;
}>;

declare const validatedGrantExchangeRequest: unique symbol;

/** Grant request whose caller assertions were matched to authenticated connector context. */
export type ValidatedGrantExchangeRequest = GrantExchangeRequest & Readonly<{
  [validatedGrantExchangeRequest]: true;
}>;

export type SealedGrantEnvelope = Readonly<{
  v: 1;
  algorithm: typeof CHANNEL_SEALED_BOX_ALGORITHM;
  recipientKeyThumbprint: string;
  /** Unpadded base64url. The sealed box embeds its ephemeral X25519 key. */
  ciphertext: string;
}>;

/** Strict plaintext opened from `SealedGrantEnvelope` before local activation. */
export type SealedGrantPayload = Readonly<{
  v: 1;
  operationId: string;
  requester: StableAgentPrincipal;
  origin: string;
  sessionGeneration: number;
  deviceId: DeviceId;
  proofKeyThumbprint: string;
  recipientKeyThumbprint: string;
  expiresAt: string;
  grant: string;
}>;

/**
 * Connector readiness acknowledgement for one exchanged operation. It is sent only
 * after local activation; the service then reports `connected` and deletes the
 * stored envelope. It carries identifiers and thumbprints, never a grant.
 */
export type ChannelAccessReadiness = Readonly<{
  v: 1;
  operationId: string;
  requester: StableAgentPrincipal;
  origin: string;
  sessionGeneration: number;
  deviceId: DeviceId;
  proofKeyThumbprint: string;
  recipientKeyThumbprint: string;
}>;

export type DiscoveryCredentialValidity =
  | 'valid'
  | 'expired'
  | 'wrong_origin'
  | 'wrong_requester'
  | 'wrong_generation'
  | 'proof_mismatch'
  | 'crypto_unavailable';

export type KeyThumbprintResult =
  | Readonly<{ ok: true; thumbprint: string }>
  | Readonly<{ ok: false; reason: 'crypto_unavailable' }>;

export type SealedGrantPayloadValidity =
  | 'valid'
  | 'expired'
  | 'operation_mismatch'
  | 'wrong_requester'
  | 'wrong_origin'
  | 'wrong_generation'
  | 'wrong_device'
  | 'proof_mismatch'
  | 'encryption_key_mismatch';

export type GrantExchangeBindingMatch = 'match' | 'unbound' | 'key_reuse';

export type ChannelDiscoveryRejection =
  | 'auth_required'
  | 'expired'
  | 'wrong_origin'
  | 'wrong_generation'
  | 'proof_mismatch'
  | 'rate_limited'
  | 'operation_mismatch';

/**
 * Agent-facing discovery. `requestAccess` and `requestChannelCreate` can only
 * journal owner decisions. The exact absence of `create` and `admit` is tested.
 */
export interface ChannelDiscoveryPort {
  list(
    input: ChannelListQuery,
    requester: DiscoveryRequester,
    options?: CallOptions,
  ): Promise<OperationResult<ChannelListingPage, ChannelDiscoveryRejection>>;
  requestAccess(
    input: ChannelAccessRequest,
    requester: DiscoveryRequester,
    options?: CallOptions,
  ): Promise<AccessRequestStatus>;
  requestChannelCreate(
    input: ChannelCreateIntent,
    requester: DiscoveryRequester,
    options?: CallOptions,
  ): Promise<AccessRequestStatus>;
  inspectRequest(
    operationId: string,
    requester: DiscoveryRequester,
    options?: CallOptions,
  ): Promise<AccessRequestStatus>;
}

export type HumanAuthorizedWorkflowContext = Readonly<{
  v: 1;
  kind: 'human_authorized_channel_create';
  ownerId: OwnerId;
  /** Opaque reference to a current authenticated human decision. */
  authorizationRef: string;
  expiresAt: string;
}>;

export type ChannelCreateReconciliation = Readonly<{
  v: 1;
  idempotencyKey: string;
  outcome: ChannelCreateOutcome;
  /** Server-only reference; absent until creation is proven. */
  channelRef: AuthorizedChannelRef | null;
}>;

/** Human-workflow-only provider adapter; never embedded in ChannelDiscoveryPort. */
export interface ChannelCreateAdapterPort {
  create(input: Readonly<{
    intent: ChannelCreateIntent;
    workflow: HumanAuthorizedWorkflowContext;
    idempotencyKey: string;
  }>, options?: CallOptions): Promise<ChannelCreateReconciliation>;
  reconcile(input: Readonly<{
    workflow: HumanAuthorizedWorkflowContext;
    idempotencyKey: string;
  }>, options?: CallOptions): Promise<ChannelCreateReconciliation>;
}

export type PrivateEligibilityMutation = Readonly<{
  v: 1;
  operationId: string;
  channelRef: AuthorizedChannelRef;
  principal: StableAgentPrincipal;
  /** The session generation is revalidated whenever this eligibility is used. */
  expectedSessionGeneration: number;
  expectedRevision: string;
}>;

/** Owner-only private allowlist administration. */
export interface ChannelPrivateEligibilityPort {
  allow(
    input: PrivateEligibilityMutation,
    owner: AuthPrincipal,
    options?: CallOptions,
  ): Promise<OperationResult<null, 'forbidden' | 'stale_revision' | 'operation_mismatch'>>;
  revoke(
    input: PrivateEligibilityMutation,
    owner: AuthPrincipal,
    options?: CallOptions,
  ): Promise<OperationResult<null, 'forbidden' | 'stale_revision' | 'operation_mismatch'>>;
}

export type GrantExchangeRejection =
  /** Denied, revoked, deleted, or otherwise no longer exchangeable. Never a reason. */
  | 'closed'
  | 'expired'
  | 'proof_mismatch'
  | 'encryption_key_mismatch'
  | 'wrong_origin'
  | 'wrong_requester'
  | 'wrong_generation'
  | 'wrong_device'
  | 'operation_mismatch'
  | 'key_reuse'
  | 'crypto_unavailable';

export type GrantExchangeValidation =
  | Readonly<{ ok: true; request: ValidatedGrantExchangeRequest }>
  | Readonly<{ ok: false; reason: GrantExchangeRejection }>;

/** Connector-only boundary; its sealed envelope never appears in request status. */
export interface AdmissionGrantExchangePort {
  exchange(
    input: ValidatedGrantExchangeRequest,
    options?: CallOptions,
  ): Promise<OperationResult<SealedGrantEnvelope, GrantExchangeRejection>>;
}

const UNSAFE_TITLE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function readUntrustedTitle(input: unknown, path: string): string {
  if (typeof input !== 'string') fail(path, 'wrong_type');
  if (!isWellFormed(input)) fail(path, 'malformed_unicode');
  if (utf8Length(input) > MAX_CHANNEL_TITLE_BYTES) fail(path, 'too_long');
  if (input.length === 0) fail(path, 'empty');
  const normalized = input.replace(UNSAFE_TITLE, '\ufffd');
  if (utf8Length(normalized) > MAX_CHANNEL_TITLE_BYTES) fail(path, 'too_long');
  return normalized;
}

function readCanonicalChannelUrl(input: unknown, path: string, trustedOrigin: string): string {
  if (typeof input !== 'string') fail(path, 'wrong_type');
  if (utf8Length(input) > MAX_CHANNEL_URL_BYTES) fail(path, 'too_long');
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    fail(path, 'invalid_value');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname === '/'
    || parsed.href !== input) fail(path, 'invalid_value');
  if (parsed.origin !== trustedOrigin) fail(path, 'mismatch');
  return input;
}

function readBase64Url(input: unknown, path: string, minBytes: number, maxBytes: number): string {
  if (typeof input !== 'string') fail(path, 'wrong_type');
  if (!BASE64URL.test(input) || input.length % 4 === 1) fail(path, 'invalid_value');
  const byteLength = Math.floor(input.length * 6 / 8);
  if (byteLength < minBytes || byteLength > maxBytes) fail(path, byteLength > maxBytes ? 'too_long' : 'invalid_value');
  const unusedBits = input.length * 6 % 8;
  if (unusedBits > 0) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(input[input.length - 1] as string);
    if ((last & ((1 << unusedBits) - 1)) !== 0) fail(path, 'invalid_value');
  }
  return input;
}

function readThumbprint(input: unknown, path: string): string {
  return readBase64Url(input, path, 32, 32);
}

function readEd25519ProofKey(input: unknown, path: string): Ed25519ProofKey {
  const r = object(input, path, ['algorithm', 'publicKey', 'thumbprint']);
  return {
    algorithm: literal(r.field('algorithm'), r.at('algorithm'), ['Ed25519']),
    publicKey: readBase64Url(r.field('publicKey'), r.at('publicKey'), 32, 32),
    thumbprint: readThumbprint(r.field('thumbprint'), r.at('thumbprint')),
  };
}

function readX25519EncryptionKey(input: unknown, path: string): X25519EncryptionKey {
  const r = object(input, path, ['algorithm', 'publicKey', 'thumbprint']);
  return {
    algorithm: literal(r.field('algorithm'), r.at('algorithm'), ['X25519']),
    publicKey: readBase64Url(r.field('publicKey'), r.at('publicKey'), 32, 32),
    thumbprint: readThumbprint(r.field('thumbprint'), r.at('thumbprint')),
  };
}

function readDiscoveryRequester(input: unknown, path: string): DiscoveryRequester {
  const r = object(input, path, ['principal', 'origin', 'proofKey', 'sessionGeneration']);
  return {
    principal: identifier(r.field('principal'), r.at('principal')) as StableAgentPrincipal,
    origin: readCanonicalOrigin(r.field('origin'), r.at('origin')),
    proofKey: readEd25519ProofKey(r.field('proofKey'), r.at('proofKey')),
    sessionGeneration: safeInteger(r.field('sessionGeneration'), r.at('sessionGeneration')),
  };
}

function readChannelListing(input: unknown, path: string): ChannelListing {
  const r = object(input, path, ['v', 'listingRef', 'title', 'visibility', 'serviceKind', 'requestState']);
  return {
    v: version(r.field('v'), r.at('v')),
    listingRef: identifier(r.field('listingRef'), r.at('listingRef')),
    title: readUntrustedTitle(r.field('title'), r.at('title')),
    visibility: literal(r.field('visibility'), r.at('visibility'), ['public', 'private', 'secret']),
    serviceKind: literal(r.field('serviceKind'), r.at('serviceKind'), ['internal', 'external']),
    requestState: literal(r.field('requestState'), r.at('requestState'), ['not_requested', ...ACCESS_REQUEST_OUTCOMES]),
  };
}

export function decodeChannelListing(input: unknown): Decoded<ChannelListing> {
  return decodeWith(() => readChannelListing(input, ''));
}

export function decodeChannelListingPage(input: unknown): Decoded<ChannelListingPage> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'items', 'nextCursor']);
    const rawItems = array(r.field('items'), r.at('items'));
    if (rawItems.length > MAX_CHANNEL_LIST_PAGE_SIZE) fail(r.at('items'), 'too_long');
    const seen = new Set<string>();
    const items = rawItems.map((item, index) => {
      const decoded = readChannelListing(item, elementPath(r.at('items'), index));
      if (seen.has(decoded.listingRef)) fail(`${elementPath(r.at('items'), index)}.listingRef`, 'duplicate');
      seen.add(decoded.listingRef);
      return decoded;
    });
    return {
      v: version(r.field('v'), r.at('v')),
      items,
      nextCursor: nullable(r.field('nextCursor'), value => identifier(value, r.at('nextCursor'))),
    };
  });
}

export function decodeChannelListQuery(input: unknown): Decoded<ChannelListQuery> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'cursor', 'limit']);
    const limit = safeInteger(r.field('limit'), r.at('limit'));
    if (limit < 1 || limit > MAX_CHANNEL_LIST_PAGE_SIZE) fail(r.at('limit'), 'invalid_value');
    return {
      v: version(r.field('v'), r.at('v')),
      cursor: nullable(r.field('cursor'), value => identifier(value, r.at('cursor'))),
      limit,
    };
  });
}

export function decodeAccessRequestStatus(input: unknown): Decoded<AccessRequestStatus> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'operationId', 'outcome']);
    return {
      v: version(r.field('v'), r.at('v')),
      operationId: identifier(r.field('operationId'), r.at('operationId')),
      outcome: literal(r.field('outcome'), r.at('outcome'), ACCESS_REQUEST_OUTCOMES),
    };
  });
}

export function decodeChannelAccessRequest(input: unknown, trustedOrigin: string): Decoded<ChannelAccessRequest> {
  return decodeWith(() => {
    readCanonicalOrigin(trustedOrigin, 'trustedOrigin');
    const envelope = object(input, '', ['v', 'kind', 'operationId', 'credentialRef',
      ...(typeof input === 'object' && input !== null && (input as { kind?: unknown }).kind === 'listing_ref'
        ? ['listingRef']
        : ['channelUrl'])]);
    const kind = literal(envelope.field('kind'), envelope.at('kind'), ['listing_ref', 'channel_url']);
    const common = {
      v: version(envelope.field('v'), envelope.at('v')),
      operationId: identifier(envelope.field('operationId'), envelope.at('operationId')),
      credentialRef: identifier(envelope.field('credentialRef'), envelope.at('credentialRef')),
    };
    return kind === 'listing_ref'
      ? { ...common, kind, listingRef: identifier(envelope.field('listingRef'), envelope.at('listingRef')) }
      : { ...common, kind, channelUrl: readCanonicalChannelUrl(envelope.field('channelUrl'), envelope.at('channelUrl'), trustedOrigin) };
  });
}

export function decodeChannelCreateIntent(input: unknown): Decoded<ChannelCreateIntent> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'operationId', 'credentialRef', 'origin', 'proposedTitle']);
    return {
      v: version(r.field('v'), r.at('v')),
      operationId: identifier(r.field('operationId'), r.at('operationId')),
      credentialRef: identifier(r.field('credentialRef'), r.at('credentialRef')),
      origin: readCanonicalOrigin(r.field('origin'), r.at('origin')),
      proposedTitle: readUntrustedTitle(r.field('proposedTitle'), r.at('proposedTitle')),
    };
  });
}

export function decodeChannelCreateReconciliation(input: unknown): Decoded<ChannelCreateReconciliation> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'idempotencyKey', 'outcome', 'channelRef']);
    const outcome = literal(r.field('outcome'), r.at('outcome'), CHANNEL_CREATE_OUTCOMES);
    const channelRef = nullable(
      r.field('channelRef'),
      value => identifier(value, r.at('channelRef')) as AuthorizedChannelRef,
    );
    const hasCreatedChannel = outcome === 'created' || outcome === 'already_created';
    if (hasCreatedChannel !== (channelRef !== null)) fail(r.at('channelRef'), 'invalid_value');
    return {
      v: version(r.field('v'), r.at('v')),
      idempotencyKey: identifier(r.field('idempotencyKey'), r.at('idempotencyKey')),
      outcome,
      channelRef,
    };
  });
}

export function decodeDiscoveryCredential(input: unknown): Decoded<DiscoveryCredential> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'credentialRef', 'audience', 'requester', 'scopes', 'expiresAt']);
    const scopes = array(r.field('scopes'), r.at('scopes'));
    if (scopes.length !== CHANNEL_DISCOVERY_SCOPES.length
      || scopes.some((scope, index) => scope !== CHANNEL_DISCOVERY_SCOPES[index])) fail(r.at('scopes'), 'invalid_value');
    return {
      v: version(r.field('v'), r.at('v')),
      credentialRef: identifier(r.field('credentialRef'), r.at('credentialRef')),
      audience: literal(r.field('audience'), r.at('audience'), ['khala-channel-discovery']),
      requester: readDiscoveryRequester(r.field('requester'), r.at('requester')),
      scopes: CHANNEL_DISCOVERY_SCOPES,
      expiresAt: utcTimestamp(r.field('expiresAt'), r.at('expiresAt')),
    };
  });
}

/** RFC 7638 SHA-256 thumbprint for an OKP public key. */
export async function deriveOkpKeyThumbprint(
  key: Ed25519ProofKey | X25519EncryptionKey,
): Promise<KeyThumbprintResult> {
  try {
    const canonicalJwk = JSON.stringify({ crv: key.algorithm, kty: 'OKP', x: key.publicKey });
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(canonicalJwk),
    ));
    const encoded = btoa(String.fromCharCode(...digest)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
    return { ok: true, thumbprint: encoded };
  } catch {
    return { ok: false, reason: 'crypto_unavailable' };
  }
}

export async function validateDiscoveryCredential(
  credential: DiscoveryCredential,
  current: Readonly<{
    requester: StableAgentPrincipal;
    origin: string;
    proofKeyThumbprint: string;
    sessionGeneration: number;
    nowMs: number;
  }>,
): Promise<DiscoveryCredentialValidity> {
  if (current.nowMs >= Date.parse(credential.expiresAt)) return 'expired';
  if (credential.requester.origin !== current.origin) return 'wrong_origin';
  if (credential.requester.principal !== current.requester) return 'wrong_requester';
  if (credential.requester.sessionGeneration !== current.sessionGeneration) return 'wrong_generation';
  const derived = await deriveOkpKeyThumbprint(credential.requester.proofKey);
  if (!derived.ok) return derived.reason;
  if (credential.requester.proofKey.thumbprint !== derived.thumbprint
    || derived.thumbprint !== current.proofKeyThumbprint) return 'proof_mismatch';
  return 'valid';
}

export function decodeGrantExchangeRequest(input: unknown): Decoded<GrantExchangeRequest> {
  return decodeWith(() => {
    const r = object(input, '', [
      'v', 'operationId', 'requester', 'origin', 'proofKey', 'encryptionKey', 'deviceId', 'sessionGeneration', 'expiresAt',
    ]);
    const proofKey = readEd25519ProofKey(r.field('proofKey'), r.at('proofKey'));
    const encryptionKey = readX25519EncryptionKey(r.field('encryptionKey'), r.at('encryptionKey'));
    if (proofKey.publicKey === encryptionKey.publicKey) fail(`${r.at('encryptionKey')}.publicKey`, 'mismatch');
    if (proofKey.thumbprint === encryptionKey.thumbprint) fail(`${r.at('encryptionKey')}.thumbprint`, 'mismatch');
    return {
      v: version(r.field('v'), r.at('v')),
      operationId: identifier(r.field('operationId'), r.at('operationId')),
      requester: identifier(r.field('requester'), r.at('requester')) as StableAgentPrincipal,
      origin: readCanonicalOrigin(r.field('origin'), r.at('origin')),
      proofKey,
      encryptionKey,
      deviceId: readId<'DeviceId'>(r.field('deviceId'), r.at('deviceId')),
      sessionGeneration: safeInteger(r.field('sessionGeneration'), r.at('sessionGeneration')),
      expiresAt: utcTimestamp(r.field('expiresAt'), r.at('expiresAt')),
    };
  });
}

/**
 * Matches caller-controlled request fields and derived key thumbprints to
 * context produced by connector authentication.
 */
export async function validateGrantExchangeRequest(
  request: GrantExchangeRequest,
  current: Readonly<{
    operationId: string;
    requester: StableAgentPrincipal;
    origin: string;
    sessionGeneration: number;
    deviceId: DeviceId;
    proofKeyThumbprint: string;
    nowMs: number;
  }>,
): Promise<GrantExchangeValidation> {
  if (current.nowMs >= Date.parse(request.expiresAt)) return { ok: false, reason: 'expired' };
  if (request.operationId !== current.operationId) return { ok: false, reason: 'operation_mismatch' };
  if (request.requester !== current.requester) return { ok: false, reason: 'wrong_requester' };
  if (request.origin !== current.origin) return { ok: false, reason: 'wrong_origin' };
  if (request.sessionGeneration !== current.sessionGeneration) return { ok: false, reason: 'wrong_generation' };
  if (request.deviceId !== current.deviceId) return { ok: false, reason: 'wrong_device' };
  const proofThumbprint = await deriveOkpKeyThumbprint(request.proofKey);
  const encryptionThumbprint = await deriveOkpKeyThumbprint(request.encryptionKey);
  if (!proofThumbprint.ok || !encryptionThumbprint.ok) return { ok: false, reason: 'crypto_unavailable' };
  if (request.proofKey.thumbprint !== proofThumbprint.thumbprint
    || proofThumbprint.thumbprint !== current.proofKeyThumbprint) return { ok: false, reason: 'proof_mismatch' };
  if (request.encryptionKey.thumbprint !== encryptionThumbprint.thumbprint) {
    return { ok: false, reason: 'encryption_key_mismatch' };
  }
  return { ok: true, request: request as ValidatedGrantExchangeRequest };
}

export function classifyGrantExchangeBinding(
  established: GrantExchangeBinding,
  candidate: GrantExchangeBinding,
): GrantExchangeBindingMatch {
  const samePublicKey = established.encryptionKeyPublicKey === candidate.encryptionKeyPublicKey;
  const sameThumbprint = established.encryptionKeyThumbprint === candidate.encryptionKeyThumbprint;
  if (!samePublicKey && !sameThumbprint) return 'unbound';
  return samePublicKey
    && sameThumbprint
    && established.proofKeyThumbprint === candidate.proofKeyThumbprint
    && established.operationId === candidate.operationId
    && established.deviceId === candidate.deviceId
    && established.requester === candidate.requester
    && established.origin === candidate.origin
    && established.sessionGeneration === candidate.sessionGeneration
    ? 'match'
    : 'key_reuse';
}

export function decodeSealedGrantEnvelope(input: unknown): Decoded<SealedGrantEnvelope> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'algorithm', 'recipientKeyThumbprint', 'ciphertext']);
    return {
      v: version(r.field('v'), r.at('v')),
      algorithm: literal(r.field('algorithm'), r.at('algorithm'), [CHANNEL_SEALED_BOX_ALGORITHM]),
      recipientKeyThumbprint: readThumbprint(r.field('recipientKeyThumbprint'), r.at('recipientKeyThumbprint')),
      ciphertext: readBase64Url(r.field('ciphertext'), r.at('ciphertext'), 48, MAX_SEALED_GRANT_BYTES),
    };
  });
}

export function decodeSealedGrantPayload(input: unknown): Decoded<SealedGrantPayload> {
  return decodeWith(() => {
    const r = object(input, '', [
      'v', 'operationId', 'requester', 'origin', 'sessionGeneration', 'deviceId', 'proofKeyThumbprint',
      'recipientKeyThumbprint', 'expiresAt', 'grant',
    ]);
    return {
      v: version(r.field('v'), r.at('v')),
      operationId: identifier(r.field('operationId'), r.at('operationId')),
      requester: identifier(r.field('requester'), r.at('requester')) as StableAgentPrincipal,
      origin: readCanonicalOrigin(r.field('origin'), r.at('origin')),
      sessionGeneration: safeInteger(r.field('sessionGeneration'), r.at('sessionGeneration')),
      deviceId: readId<'DeviceId'>(r.field('deviceId'), r.at('deviceId')),
      proofKeyThumbprint: readThumbprint(r.field('proofKeyThumbprint'), r.at('proofKeyThumbprint')),
      recipientKeyThumbprint: readThumbprint(r.field('recipientKeyThumbprint'), r.at('recipientKeyThumbprint')),
      expiresAt: utcTimestamp(r.field('expiresAt'), r.at('expiresAt')),
      grant: identifier(r.field('grant'), r.at('grant')),
    };
  });
}

export function validateSealedGrantPayload(
  payload: SealedGrantPayload,
  expected: Readonly<{
    operationId: string;
    requester: StableAgentPrincipal;
    origin: string;
    sessionGeneration: number;
    deviceId: DeviceId;
    proofKeyThumbprint: string;
    recipientKeyThumbprint: string;
    nowMs: number;
  }>,
): SealedGrantPayloadValidity {
  if (expected.nowMs >= Date.parse(payload.expiresAt)) return 'expired';
  if (payload.operationId !== expected.operationId) return 'operation_mismatch';
  if (payload.requester !== expected.requester) return 'wrong_requester';
  if (payload.origin !== expected.origin) return 'wrong_origin';
  if (payload.sessionGeneration !== expected.sessionGeneration) return 'wrong_generation';
  if (payload.deviceId !== expected.deviceId) return 'wrong_device';
  if (payload.proofKeyThumbprint !== expected.proofKeyThumbprint) return 'proof_mismatch';
  if (payload.recipientKeyThumbprint !== expected.recipientKeyThumbprint) return 'encryption_key_mismatch';
  return 'valid';
}

export function decodeChannelAccessReadiness(input: unknown): Decoded<ChannelAccessReadiness> {
  return decodeWith(() => {
    const r = object(input, '', [
      'v', 'operationId', 'requester', 'origin', 'sessionGeneration', 'deviceId', 'proofKeyThumbprint',
      'recipientKeyThumbprint',
    ]);
    const proofKeyThumbprint = readThumbprint(r.field('proofKeyThumbprint'), r.at('proofKeyThumbprint'));
    const recipientKeyThumbprint = readThumbprint(r.field('recipientKeyThumbprint'), r.at('recipientKeyThumbprint'));
    if (proofKeyThumbprint === recipientKeyThumbprint) fail(r.at('recipientKeyThumbprint'), 'mismatch');
    return {
      v: version(r.field('v'), r.at('v')),
      operationId: identifier(r.field('operationId'), r.at('operationId')),
      requester: identifier(r.field('requester'), r.at('requester')) as StableAgentPrincipal,
      origin: readCanonicalOrigin(r.field('origin'), r.at('origin')),
      sessionGeneration: safeInteger(r.field('sessionGeneration'), r.at('sessionGeneration')),
      deviceId: readId<'DeviceId'>(r.field('deviceId'), r.at('deviceId')),
      proofKeyThumbprint,
      recipientKeyThumbprint,
    };
  });
}
