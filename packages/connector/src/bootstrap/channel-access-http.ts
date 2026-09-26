// HTTP transport for channel-access activation. Each request goes to one exact
// configured origin with a fresh sender-constrained proof, no redirects and a
// bounded JSON read. The sealed envelope passes through unopened; activation
// decodes it again. Response bodies and transport errors are never logged.

import {
  type AccessRequestOutcome,
  type DiscoveryCredential,
  type GrantExchangeRejection,
  decodeAccessRequestStatus,
} from '@khala/contracts/messaging/index';
import type { ChannelAccessExchangeClient, ChannelAccessStatusPort, ExchangeOutcome } from './channel-access-activation';
import { isAcceptableOrigin, readBounded } from './discovery';
import type { ProofSigner } from './proof';

export const CHANNEL_ACCESS_EXCHANGE_PATH = '/api/agent/channel-access/exchange';
export const CHANNEL_ACCESS_READY_PATH = '/api/agent/channel-access/ready';
export const CHANNEL_ACCESS_STATUS_PATH = '/api/agent/channel-access/status';

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
  fetch?: typeof fetch;
}>;

type Reply = Readonly<{ kind: 'response'; status: number; body: unknown }> | Readonly<{ kind: 'failed' }>;

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
      const target = url(request.origin, CHANNEL_ACCESS_EXCHANGE_PATH, request.operationId);
      if (target === null) return { kind: 'rejected', code: 'wrong_origin' };
      const reply = await send(transport, 'POST', target, request.origin, { dpop: options.signer.proof('POST', target) }, request);
      // A lost response is retried; the service returns the same stored envelope.
      if (reply.kind === 'failed') return { kind: 'unavailable' };
      if (reply.status === 200 && reply.body !== null) return { kind: 'sealed', envelope: reply.body };
      const code = rejectionCode(reply);
      return code === null ? { kind: 'unavailable' } : { kind: 'rejected', code };
    },

    async acknowledge(readiness) {
      const target = url(readiness.origin, CHANNEL_ACCESS_READY_PATH, readiness.operationId);
      if (target === null) return 'rejected';
      const reply = await send(transport, 'POST', target, readiness.origin, { dpop: options.signer.proof('POST', target) }, readiness);
      if (reply.kind === 'failed') return 'unavailable';
      if (reply.status === 200 && isExact(reply.body, { v: 1, kind: 'acknowledged' })) return 'acknowledged';
      const code = rejectionCode(reply);
      if (code === 'closed' || code === 'expired') return 'closed';
      return code === null ? 'unavailable' : 'rejected';
    },
  });
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
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { kind: 'failed' };
  }
  const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    await response.body?.cancel().catch(() => undefined);
    return { kind: 'response', status: response.status, body: null };
  }
  try {
    const bytes = await readBounded(response, MAX_RESPONSE_BYTES);
    if (bytes === null || bytes.length === 0) return { kind: 'response', status: response.status, body: null };
    return { kind: 'response', status: response.status, body: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
  } catch {
    // A truncated or unreadable body after the request reached the service: treat as lost.
    return { kind: 'failed' };
  }
}
