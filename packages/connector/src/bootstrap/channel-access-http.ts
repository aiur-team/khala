// HTTP transport for channel-access activation. Each request goes to one exact
// configured origin with a fresh sender-constrained proof, no redirects and a
// bounded JSON read. The sealed envelope passes through unopened; activation
// decodes it again. Response bodies and transport errors are never logged.

import { createHash } from 'node:crypto';
import {
  type AccessRequestOutcome,
  type DiscoveryCredential,
  type GrantExchangeRejection,
  decodeAccessRequestStatus,
} from '@khala/contracts/messaging/index';
import type { ChannelAccessExchangeClient, ChannelAccessRedeemPort, ChannelAccessStatusPort, ExchangeOutcome } from './channel-access-activation';
import { isAcceptableOrigin, readBounded } from './discovery';
import type { ProofSigner } from './proof';
import { createHttpAdmission, parseChannelAccessAdmission } from './loopback';
import type { OwnershipGrant } from './ports';

export const CHANNEL_ACCESS_EXCHANGE_PATH = '/api/agent/channel-access/exchange';
export const CHANNEL_ACCESS_READY_PATH = '/api/agent/channel-access/ready';
export const CHANNEL_ACCESS_STATUS_PATH = '/api/agent/channel-access/status';
export const CHANNEL_ACCESS_RESUME_PATH = '/api/agent/channel-access/resume';

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 32_768;
const EXCHANGE_REJECTIONS: ReadonlySet<GrantExchangeRejection> = new Set([
  'closed', 'expired', 'proof_mismatch', 'encryption_key_mismatch', 'wrong_origin', 'wrong_requester', 'wrong_generation',
  'wrong_device', 'operation_mismatch', 'key_reuse',
]);

export type ChannelAccessHttpOptions = Readonly<{
  signer: ProofSigner;
  /** Exact configured service origins. The journaled origin must be one of them. */
  trustedOrigins: readonly string[];
  /** The live owner-approved discovery credential; never persisted by this client. */
  credential(): DiscoveryCredential | null;
  fetch?: typeof fetch;
  /** Exchange-only, fixed and redacted local failure checkpoint. */
  diagnostic?(event: ExchangeHttpDiagnostic): void;
}>;

export type ExchangeHttpDiagnostic = Readonly<{
  stage: 'credential_unavailable' | 'credential_mismatch' | 'proof_unavailable' | 'transport_failed'
    | 'http_status' | 'body_media_type' | 'body_missing' | 'body_read_failed' | 'body_json_invalid';
  result: 'unavailable';
  httpStatus?: number;
}>;

type Reply =
  | Readonly<{ kind: 'response'; status: number; body: unknown; bodyFailure?: 'body_media_type' | 'body_missing' }>
  | Readonly<{ kind: 'failed'; stage: Exclude<ExchangeHttpDiagnostic['stage'], 'http_status' | 'body_media_type' | 'body_missing'>;
    status?: number }>;

/** Connector-only exchange and readiness client. */
export function createHttpChannelAccessClient(options: ChannelAccessHttpOptions): ChannelAccessExchangeClient {
  const trusted = trustedSet(options.trustedOrigins);
  const transport = options.fetch ?? fetch;

  function url(origin: string, path: string, operationId: string): string | null {
    if (!trusted.has(origin)) return null;
    return `${origin}${path}?${new URLSearchParams({ operation: operationId }).toString()}`;
  }

  return Object.freeze<ChannelAccessExchangeClient>({
    async exchange(request): Promise<ExchangeOutcome> {
      function report(stage: ExchangeHttpDiagnostic['stage'], status?: number): void {
        try { options.diagnostic?.({ stage, result: 'unavailable',
          ...(status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599 ? { httpStatus: status } : {}) }); }
        catch { /* Local diagnostics cannot change an exchange outcome. */ }
      }
      const target = url(request.origin, CHANNEL_ACCESS_EXCHANGE_PATH, request.operationId);
      if (target === null) return { kind: 'rejected', code: 'wrong_origin' };
      const reply = await protectedPost(options, transport, target, request.origin, request);
      // A lost response is retried; the service returns the same stored envelope.
      if (reply.kind === 'failed') {
        report(reply.status !== undefined && reply.status !== 200 ? 'http_status' : reply.stage, reply.status);
        return { kind: 'unavailable' };
      }
      if (reply.status === 200 && reply.body !== null) return { kind: 'sealed', envelope: reply.body };
      const code = rejectionCode(reply);
      if (code !== null) return { kind: 'rejected', code };
      report(reply.status === 200 ? reply.bodyFailure ?? 'body_missing' : 'http_status', reply.status);
      return { kind: 'unavailable' };
    },

    async acknowledge(readiness) {
      const target = url(readiness.origin, CHANNEL_ACCESS_READY_PATH, readiness.operationId);
      if (target === null) return 'rejected';
      const reply = await protectedPost(options, transport, target, readiness.origin, readiness);
      if (reply.kind === 'failed') return 'unavailable';
      if (reply.status === 200 && isExact(reply.body, { v: 1, kind: 'acknowledged' })) return 'acknowledged';
      const code = rejectionCode(reply);
      if (code === 'closed' || code === 'expired') return 'closed';
      return code === null ? 'unavailable' : 'rejected';
    },
  });
}

/** Redeems the sealed grant once, then resumes the same admitted binding by operation ID. */
export function createHttpChannelAccessRedeem(options: ChannelAccessHttpOptions): ChannelAccessRedeemPort {
  const trusted = trustedSet(options.trustedOrigins);
  const transport = options.fetch ?? fetch;
  return {
    async redeem(input) {
      const credential = options.credential();
      if (!trusted.has(input.origin) || !credentialMatches(credential, input.origin, options.signer)) return { kind: 'unavailable' };
      const grant: OwnershipGrant = {
        method: 'loopback-browser-v1', expiresAt: Number.MAX_SAFE_INTEGER,
        secret: input.grant,
        redeem: `${input.origin}/api/agent/bootstrap/redeem`,
        deviceId: input.deviceId,
        session: { harness: 'proof-key', sessionId: credential.requester.principal,
          generation: credential.requester.sessionGeneration },
      } as OwnershipGrant;
      return createHttpAdmission({ signer: options.signer, fetch: transport }).redeem({ grant, operationId: input.operationId });
    },
    async resume(input) {
      if (!trusted.has(input.origin)) return { kind: 'unavailable' };
      const target = `${input.origin}${CHANNEL_ACCESS_RESUME_PATH}?${new URLSearchParams({ operation: input.operationId })}`;
      const credential = options.credential();
      if (!credentialMatches(credential, input.origin, options.signer)) return { kind: 'unavailable' };
      const reply = await protectedPost(options, transport, target, input.origin, {
        v: 1, operationId: input.operationId, requester: credential.requester.principal,
        origin: input.origin, sessionGeneration: credential.requester.sessionGeneration,
        deviceId: input.deviceId, ...(input.bindingId ? { bindingId: input.bindingId } : {}),
        proofKeyThumbprint: options.signer.jkt,
      });
      if (reply.kind === 'failed') return { kind: 'outcome_unknown' };
      if (reply.status === 409 && isExact(reply.body, { v: 1, kind: 'rejected', code: 'operation_mismatch' })) {
        return { kind: 'not_redeemed' };
      }
      if (reply.status === 409) return { kind: 'refused', code: 'binding_conflict' };
      if (reply.status === 410) return { kind: 'refused', code: 'binding_revoked' };
      if (reply.status !== 200) return reply.status >= 500 ? { kind: 'unavailable' } : { kind: 'refused', code: 'admission_denied' };
      // Use the same strict capability and Matrix-session parser as bootstrap redeem.
      return parseChannelAccessAdmission(reply.body);
    },
  };
}

function credentialMatches(credential: DiscoveryCredential | null, origin: string, signer: ProofSigner): credential is DiscoveryCredential {
  return credential !== null && credential.requester.origin === origin
    && credential.requester.proofKey.thumbprint === signer.jkt;
}

async function protectedPost(options: ChannelAccessHttpOptions, transport: typeof fetch, target: string, origin: string, body: unknown): Promise<Reply> {
  let credential: DiscoveryCredential | null;
  try { credential = options.credential(); }
  catch { return { kind: 'failed', stage: 'credential_unavailable' }; }
  if (credential === null) return { kind: 'failed', stage: 'credential_unavailable' };
  if (!credentialMatches(credential, origin, options.signer)) return { kind: 'failed', stage: 'credential_mismatch' };
  let raw: string;
  let proof: string;
  try {
    raw = JSON.stringify(body);
    proof = options.signer.proof('POST', target, credential.credentialRef,
      { bodyHash: createHash('sha256').update(raw).digest('base64url') });
  } catch { return { kind: 'failed', stage: 'proof_unavailable' }; }
  return send(transport, 'POST', target, origin, {
    authorization: `DPoP ${credential.credentialRef}`, dpop: proof,
  }, raw);
}

/**
 * Requester status over the agent route, authorized by the live in-memory discovery
 * credential. Without one, status is `unavailable`, never guessed.
 */
export function createHttpChannelAccessStatus(options: ChannelAccessHttpOptions & Readonly<{
  credential(): DiscoveryCredential | null;
}>): ChannelAccessStatusPort {
  const trusted = trustedSet(options.trustedOrigins);
  const transport = options.fetch ?? fetch;
  return Object.freeze<ChannelAccessStatusPort>({
    async inspect({ operationId, origin }): Promise<AccessRequestOutcome | 'unavailable'> {
      const credential = options.credential();
      if (!trusted.has(origin) || credential === null || credential.requester.origin !== origin) return 'unavailable';
      const query = new URLSearchParams({ v: '1', operationId, operationKind: 'access' }).toString();
      const target = `${origin}${CHANNEL_ACCESS_STATUS_PATH}?${query}`;
      const reply = await send(transport, 'GET', target, origin, {
        authorization: `DPoP ${credential.credentialRef}`,
        dpop: options.signer.proof('GET', target, credential.credentialRef),
      });
      if (reply.kind === 'failed' || reply.status !== 200) return 'unavailable';
      const status = decodeAccessRequestStatus(reply.body);
      return status.ok && status.value.operationId === operationId ? status.value.outcome : 'unavailable';
    },
  });
}

function trustedSet(origins: readonly string[]): ReadonlySet<string> {
  for (const origin of origins) {
    if (!isAcceptableOrigin(origin)) throw new Error('trusted origins must be exact https (or loopback http) origins');
  }
  return new Set(origins);
}

function rejectionCode(reply: Extract<Reply, { kind: 'response' }>): GrantExchangeRejection | null {
  if (reply.status !== 409 && reply.status !== 410) return null;
  const body = reply.body as { v?: unknown; kind?: unknown; code?: unknown } | null;
  if (body === null || typeof body !== 'object' || body.v !== 1 || body.kind !== 'rejected') return null;
  const code = body.code as GrantExchangeRejection;
  return EXCHANGE_REJECTIONS.has(code) ? code : null;
}

function isExact(value: unknown, expected: Record<string, unknown>): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === Object.keys(expected).length
    && keys.every(key => (value as Record<string, unknown>)[key] === expected[key]);
}

async function send(
  transport: typeof fetch,
  method: 'GET' | 'POST',
  url: string,
  origin: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Reply> {
  let response: Response;
  try {
    response = await transport(url, {
      method,
      headers: {
        accept: 'application/json',
        ...(method === 'POST' ? { 'content-type': 'application/json', origin } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { kind: 'failed', stage: 'transport_failed' };
  }
  const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    await response.body?.cancel().catch(() => undefined);
    return { kind: 'response', status: response.status, body: null, bodyFailure: 'body_media_type' };
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await readBounded(response, MAX_RESPONSE_BYTES);
  } catch {
    return { kind: 'failed', stage: 'body_read_failed', status: response.status };
  }
  if (bytes === null) return { kind: 'failed', stage: 'body_read_failed', status: response.status };
  if (bytes.length === 0) return { kind: 'response', status: response.status, body: null, bodyFailure: 'body_missing' };
  try {
    return { kind: 'response', status: response.status, body: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
  } catch { return { kind: 'failed', stage: 'body_json_invalid', status: response.status }; }
}
