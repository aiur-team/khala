// Connector-only route for the channel-access grant exchange. Authority comes from
// the composition's connector authentication (verified session plus a fresh proof
// for the bound key), never from caller JSON; the body's assertions must match it.
// The response is the sealed envelope alone. No agent status, CLI or MCP surface
// reaches this route, and nothing here is logged.

import {
  type AdmissionGrantExchangePort,
  type DeviceId,
  type GrantExchangeRejection,
  type StableAgentPrincipal,
  type TrustedClock,
  decodeGrantExchangeRequest,
  decodeSealedGrantEnvelope,
  validateGrantExchangeRequest,
} from '@khala/contracts/messaging/index';
import type { RouteRegistration } from '../../runtime/handler';

/**
 * The gateway routes exact paths under reserved prefixes only, so the contract's
 * `/api/connector/channel-access-requests/<operation>/exchange` is served here with
 * the operation named once in the query and once in the body.
 */
export const CONNECTOR_CHANNEL_ACCESS_EXCHANGE_PATH = '/api/agent/channel-access/exchange';

export type VerifiedExchangeConnector = Readonly<{
  requester: StableAgentPrincipal;
  origin: string;
  sessionGeneration: number;
  sessionFingerprint: string;
  deviceId: DeviceId;
  proofKeyThumbprint: string;
}>;

export type ConnectorExchangeAuthentication =
  | Readonly<{ kind: 'authenticated'; connector: VerifiedExchangeConnector }>
  | Readonly<{ kind: 'rejected'; code: 'auth_required' | 'forbidden' }>
  | Readonly<{ kind: 'unavailable' }>;

export type GrantExchangeHandlerDependencies = Readonly<{
  /** Verifies the connector's session and sender-constrained proof for this exact request. */
  authenticateConnector(request: Request): Promise<ConnectorExchangeAuthentication>;
  /** Request-scoped exchange for one authenticated connector. */
  exchangeFor(connector: Readonly<{ sessionFingerprint: string }>): AdmissionGrantExchangePort;
  clock: TrustedClock;
}>;

const BINDING_CONFLICTS: ReadonlySet<GrantExchangeRejection> = new Set([
  'proof_mismatch', 'encryption_key_mismatch', 'wrong_origin', 'wrong_requester', 'wrong_generation', 'wrong_device',
  'operation_mismatch', 'key_reuse',
]);

export function createGrantExchangeHandler(deps: GrantExchangeHandlerDependencies): RouteRegistration {
  async function handle(request: Request): Promise<Response> {
    const operation = readOperation(request);
    if (operation === null) return rejected(400, 'invalid_request');
    const auth = await safeCall(() => deps.authenticateConnector(request));
    if (auth === null || auth.kind === 'unavailable') return unavailable();
    if (auth.kind === 'rejected') return rejected(auth.code === 'auth_required' ? 401 : 403, auth.code);
    const body = decodeGrantExchangeRequest(await readJson(request));
    if (!body.ok) return rejected(400, 'invalid_request');
    const connector = auth.connector;
    const validated = await validateGrantExchangeRequest(body.value, {
      operationId: operation,
      requester: connector.requester,
      origin: connector.origin,
      sessionGeneration: connector.sessionGeneration,
      deviceId: connector.deviceId,
      proofKeyThumbprint: connector.proofKeyThumbprint,
      nowMs: deps.clock(),
    });
    if (!validated.ok) return mapRejection(validated.reason);
    const result = await safeCall(() => deps.exchangeFor({ sessionFingerprint: connector.sessionFingerprint })
      .exchange(validated.request, { signal: request.signal }));
    if (result === null || result.kind === 'unavailable' || result.kind === 'outcome_unknown') return unavailable();
    if (result.kind === 'rejected') return mapRejection(result.code);
    const envelope = decodeSealedGrantEnvelope(result.value);
    return envelope.ok ? json(200, envelope.value) : unavailable();
  }

  return Object.freeze({
    path: CONNECTOR_CHANNEL_ACCESS_EXCHANGE_PATH,
    methods: Object.freeze(['POST']),
    handle,
  });
}

function mapRejection(code: GrantExchangeRejection): Response {
  if (code === 'crypto_unavailable') return unavailable();
  if (code === 'expired' || code === 'closed') return rejected(410, code);
  if (BINDING_CONFLICTS.has(code)) return rejected(409, code);
  return unavailable();
}

function readOperation(request: Request): string | null {
  try {
    const params = new URL(request.url).searchParams;
    const values = params.getAll('operation');
    if (values.length !== 1 || [...params.keys()].some(key => key !== 'operation')) return null;
    const value = values[0]!;
    return value.length > 0 && value.length <= 512 ? value : null;
  } catch {
    return null;
  }
}

async function readJson(request: Request): Promise<unknown> {
  if ((request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() !== 'application/json') return undefined;
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

async function safeCall<T>(operation: () => Promise<T>): Promise<T | null> {
  try {
    return await operation();
  } catch {
    return null;
  }
}

function rejected(status: number, code: string): Response {
  return json(status, { v: 1, kind: 'rejected', code });
}

function unavailable(): Response {
  return json(503, { v: 1, kind: 'unavailable' });
}

const RESPONSE_HEADERS = Object.freeze({
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: RESPONSE_HEADERS });
}
