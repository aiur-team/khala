import { type KeyObject, createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import {
  type AccessRequestStatus, type ChannelAccessDecisionCommand, type ChannelAccessDecisionRejection,
  type ChannelAccessMuteCommand, type ChannelAccessMuteResult, type ChannelAccessOwnerProjection, type ChannelAccessRequest,
  type ChannelAccessStatusQuery, type ChannelCreateIntent, type ChannelListingPage, type GrantExchangeRejection,
  type GrantExchangeRequest, type OperationResult, type SealedGrantEnvelope, decodeChannelAccessDecisionCommand,
  decodeChannelAccessMuteCommand, decodeChannelAccessRequest, decodeChannelCreateIntent, decodeGrantExchangeRequest,
} from '@khala/contracts/messaging/index';
import type { DiscoveryIdentity, HumanAuthority, Principal } from './credentials';
import { type ErrorCode, readJsonObject, sendError, sendJson } from './http';
import { type RouteContext, type RouteSpec, isRouteSegment } from './server';

// Channel discovery routes of the loopback server. Each route admits exactly one
// role, checked before the handler runs:
//
// - transport (the launch's `transportCapability`): issue a discovery descriptor.
// - discovery (a descriptor's capability): list, request access, submit a create
//   intent, read request status. Nothing else.
// - connector (a discovery capability plus a fresh DPoP proof from the separately
//   registered connector key): the grant exchange only.
// - human (cookie plus request secret): inbox, decisions, mute, visibility,
//   allowlist and the verified-agent list.
//
// Authority always comes from the authenticated principal, never from JSON.
// Responses are `no-store` like every other route, and nothing here logs.

export type DiscoveryAgentContext = DiscoveryIdentity & Readonly<{ origin: string }>;

export type DiscoveryVisibilityValue = 'public' | 'private' | 'secret';

export type DiscoverySettingsView = Readonly<{
  v: 1;
  channelId: string;
  visibility: DiscoveryVisibilityValue;
  revision: number;
  allowlist: readonly string[];
}>;

export type DiscoverySettingsMutation = Readonly<{
  operationId: string;
  expectedRevision: number;
  change:
    | Readonly<{ kind: 'visibility'; visibility: DiscoveryVisibilityValue }>
    | Readonly<{ kind: 'allow' | 'revoke'; principal: string; expectedGeneration: number }>;
}>;

export type DiscoveryAgentView = Readonly<{
  v: 1;
  principal: string;
  /** Verified session fingerprint; lead with this, never with a label. */
  fingerprint: string;
  generation: number;
  harness: string;
  /** Agent-supplied and untrusted. */
  displayLabel: string | null;
  /** Agent-supplied and untrusted. */
  workspaceLabel: string | null;
  issuedAt: string;
}>;

export type DiscoveryIssueInput = Readonly<{
  harness: string;
  sessionId: string;
  displayLabel: string | null;
  workspaceLabel: string | null;
  /** Ed25519 public key (JWK `x`) of the connector that will present exchange proofs. */
  proofPublicKey: string;
}>;

export type DiscoveryIssueResult =
  | Readonly<{ kind: 'issued'; principal: string; generation: number; discoveryCapability: string }>
  | Readonly<{ kind: 'rejected' }>
  | Readonly<{ kind: 'unavailable' }>;

export type DiscoveryListResult =
  | Readonly<{ kind: 'listed'; page: ChannelListingPage }>
  | Readonly<{ kind: 'rejected'; code: 'rate_limited' | 'cursor_unavailable' }>
  | Readonly<{ kind: 'unavailable' }>;

export type SettingsMutationRejection = 'not_found' | 'stale_revision' | 'operation_mismatch' | 'unknown_principal' | 'wrong_generation';

/** Implemented by the internal composition; the server only authenticates, decodes and maps results. */
export interface InternalDiscoveryPort {
  authenticate(capability: string): Promise<DiscoveryIdentity | null | 'unavailable'>;
  issue(input: DiscoveryIssueInput): Promise<DiscoveryIssueResult>;
  list(agent: DiscoveryAgentContext, cursor: string | null): Promise<DiscoveryListResult>;
  requestAccess(agent: DiscoveryAgentContext, request: ChannelAccessRequest): Promise<AccessRequestStatus>;
  requestCreate(agent: DiscoveryAgentContext, intent: ChannelCreateIntent): Promise<AccessRequestStatus>;
  status(agent: DiscoveryAgentContext, query: ChannelAccessStatusQuery): Promise<AccessRequestStatus>;
  exchange(
    agent: DiscoveryAgentContext,
    operationId: string,
    request: GrantExchangeRequest,
  ): Promise<OperationResult<SealedGrantEnvelope, GrantExchangeRejection>>;
  inbox(human: HumanAuthority): Promise<readonly ChannelAccessOwnerProjection[] | 'unavailable'>;
  decide(human: HumanAuthority, command: ChannelAccessDecisionCommand, kind: 'access' | 'create'):
    Promise<OperationResult<ChannelAccessOwnerProjection, ChannelAccessDecisionRejection>>;
  mute(human: HumanAuthority, command: ChannelAccessMuteCommand):
    Promise<OperationResult<ChannelAccessMuteResult, 'forbidden' | 'not_found' | 'stale_revision' | 'operation_mismatch'>>;
  settings(human: HumanAuthority, channelId: string): Promise<DiscoverySettingsView | 'not_found' | 'unavailable'>;
  updateSettings(human: HumanAuthority, channelId: string, mutation: DiscoverySettingsMutation):
    Promise<OperationResult<DiscoverySettingsView, SettingsMutationRejection>>;
  agents(human: HumanAuthority): Promise<readonly DiscoveryAgentView[] | 'unavailable'>;
}

export type DiscoveryRole = 'transport' | 'discovery' | 'human';

export const DISCOVERY_ROUTES = {
  issue: { method: 'POST', path: '/api/internal/discovery/descriptors', admission: 'authenticated' },
  list: { method: 'GET', path: '/api/agent/channels', admission: 'authenticated', allowQuery: true },
  requestAccess: { method: 'POST', path: '/api/agent/channel-access-requests', admission: 'authenticated' },
  accessStatus: {
    method: 'GET', path: '/api/agent/channel-access-requests/:operationId', template: '/api/agent/channel-access-requests/:operation',
    admission: 'authenticated',
  },
  requestCreate: { method: 'POST', path: '/api/agent/channel-create-requests', admission: 'authenticated' },
  createStatus: {
    method: 'GET', path: '/api/agent/channel-create-requests/:operationId', template: '/api/agent/channel-create-requests/:operation',
    admission: 'authenticated',
  },
  exchange: {
    method: 'POST', path: '/api/connector/channel-access-requests/:operationId/exchange',
    template: '/api/connector/channel-access-requests/:operation/exchange', admission: 'authenticated',
  },
  inbox: { method: 'GET', path: '/api/human/channel-requests', admission: 'authenticated' },
  accessDecision: { method: 'POST', path: '/api/human/channel-access-requests/:requestHandle/decision', admission: 'authenticated' },
  createDecision: { method: 'POST', path: '/api/human/channel-create-requests/:requestHandle/decision', admission: 'authenticated' },
  mute: { method: 'POST', path: '/api/human/channel-requests/mute', admission: 'authenticated' },
  settings: { method: 'GET', path: '/api/human/channels/:channelId/discovery', admission: 'authenticated' },
  updateSettings: { method: 'POST', path: '/api/human/channels/:channelId/discovery', admission: 'authenticated' },
  agents: { method: 'GET', path: '/api/human/discovery/agents', admission: 'authenticated' },
} as const satisfies Record<string, RouteSpec>;

const ROLES = new Map<RouteSpec, DiscoveryRole>([
  [DISCOVERY_ROUTES.issue, 'transport'],
  [DISCOVERY_ROUTES.list, 'discovery'],
  [DISCOVERY_ROUTES.requestAccess, 'discovery'],
  [DISCOVERY_ROUTES.accessStatus, 'discovery'],
  [DISCOVERY_ROUTES.requestCreate, 'discovery'],
  [DISCOVERY_ROUTES.createStatus, 'discovery'],
  [DISCOVERY_ROUTES.exchange, 'discovery'],
  [DISCOVERY_ROUTES.inbox, 'human'],
  [DISCOVERY_ROUTES.accessDecision, 'human'],
  [DISCOVERY_ROUTES.createDecision, 'human'],
  [DISCOVERY_ROUTES.mute, 'human'],
  [DISCOVERY_ROUTES.settings, 'human'],
  [DISCOVERY_ROUTES.updateSettings, 'human'],
  [DISCOVERY_ROUTES.agents, 'human'],
]);

/** The single role a discovery route admits, or `null` for a route this module does not own. */
export function discoveryRole(route: RouteSpec): DiscoveryRole | null {
  return ROLES.get(route) ?? null;
}

export const DPOP_HEADER = 'dpop';
/** Accepted proof age and future skew, in seconds. */
export const PROOF_MAX_AGE_S = 60;
export const PROOF_MAX_SKEW_S = 5;
const MAX_PROOF_BYTES = 2_048;
const MAX_REMEMBERED_PROOFS = 4_096;
const B64URL = /^[A-Za-z0-9_-]+$/;
const KEY_X = /^[A-Za-z0-9_-]{43}$/;
const JTI = /^[A-Za-z0-9_-]{16,64}$/;
const BOUNDED_TOKEN = /^[\x21-\x7e]{1,512}$/;

export type ProofExpectation = Readonly<{ method: string; url: string; jkt: string; accessToken: string; nowMs: number }>;

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** RFC 7638 thumbprint of an Ed25519 public key. */
export function ed25519Thumbprint(x: string): string {
  return createHash('sha256').update(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x })).digest('base64url');
}

/**
 * RFC 9449 DPoP proof check (compact EdDSA JWS) for one exact method, URL and
 * access token, signed by the key with thumbprint `jkt`. Returns the `jti` for
 * the caller's replay check, or `null` when the proof is not acceptable.
 */
export function checkProof(proof: string | undefined, expected: ProofExpectation): string | null {
  if (proof === undefined || proof.length === 0 || proof.length > MAX_PROOF_BYTES) return null;
  const parts = proof.split('.');
  if (parts.length !== 3 || !parts.every(part => B64URL.test(part))) return null;
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  const header = parseSegment(encodedHeader);
  const payload = parseSegment(encodedPayload);
  if (!header || !payload) return null;
  const jwk = header.jwk as Record<string, unknown> | undefined;
  if (header.typ !== 'dpop+jwt' || header.alg !== 'EdDSA' || typeof jwk !== 'object' || jwk === null
    || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string' || !KEY_X.test(jwk.x) || 'd' in jwk) return null;
  if (!safeEqual(ed25519Thumbprint(jwk.x), expected.jkt)) return null;
  let key: KeyObject;
  try {
    key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' });
  } catch {
    return null;
  }
  const signature = Buffer.from(encodedSignature, 'base64url');
  if (signature.length !== 64 || !verify(null, Buffer.from(`${encodedHeader}.${encodedPayload}`), key, signature)) return null;
  const now = Math.floor(expected.nowMs / 1000);
  const { iat, jti, htm, htu, ath } = payload;
  if (!Number.isSafeInteger(iat) || (iat as number) < now - PROOF_MAX_AGE_S || (iat as number) > now + PROOF_MAX_SKEW_S
    || typeof jti !== 'string' || !JTI.test(jti)) return null;
  if (htm !== expected.method || htu !== expected.url) return null;
  if (typeof ath !== 'string' || !safeEqual(ath, createHash('sha256').update(expected.accessToken).digest('base64url'))) return null;
  return jti;
}

function parseSegment(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function rejected(context: RouteContext<Principal>, status: number, code: string): void {
  sendJson(context.response, status, { v: 1, kind: 'rejected', code });
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function isLabel(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length > 0 && value.length <= 128
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value) && !/\p{Cs}/u.test(value));
}

const GRANT_CONFLICTS: ReadonlySet<GrantExchangeRejection> = new Set([
  'proof_mismatch', 'encryption_key_mismatch', 'wrong_origin', 'wrong_requester', 'wrong_generation', 'wrong_device',
  'operation_mismatch', 'key_reuse',
]);

export type DiscoveryRouteHandler = Readonly<{
  routes: readonly RouteSpec[];
  handle(context: RouteContext<Principal>): Promise<void>;
}>;

export function createDiscoveryRoutes(deps: Readonly<{
  port: InternalDiscoveryPort;
  origin: () => string;
  clock: () => number;
  maxBodyBytes: number;
}>): DiscoveryRouteHandler {
  const { port } = deps;
  // Proof `jti`s seen within the acceptance window; a replay is refused.
  const seenProofs = new Map<string, number>();

  function rememberProof(jti: string, now: number): boolean {
    for (const [seen, at] of seenProofs) {
      if (at > now - (PROOF_MAX_AGE_S + PROOF_MAX_SKEW_S) * 1000 && seenProofs.size < MAX_REMEMBERED_PROOFS) break;
      seenProofs.delete(seen);
    }
    if (seenProofs.has(jti)) return false;
    seenProofs.set(jti, now);
    return true;
  }

  function agentOf(context: RouteContext<Principal>): DiscoveryAgentContext {
    const principal = context.principal;
    if (principal?.kind !== 'discovery') throw new Error('discovery route reached without a discovery principal');
    return { ...principal.agent, origin: deps.origin() };
  }

  function humanOf(context: RouteContext<Principal>): HumanAuthority {
    const principal = context.principal;
    if (principal?.kind !== 'human') throw new Error('human route reached without a human principal');
    return principal.human;
  }

  function sendStatus(context: RouteContext<Principal>, status: AccessRequestStatus): void {
    sendJson(context.response, 200, { v: 1, operationId: status.operationId, outcome: status.outcome });
  }

  function sendUnavailable(context: RouteContext<Principal>, write: boolean): void {
    sendError(context.response, 503, write ? 'outcome_unknown' : 'unavailable');
  }

  function fail(context: RouteContext<Principal>, status: number, code: ErrorCode): void {
    sendError(context.response, status, code);
  }

  async function issue(context: RouteContext<Principal>): Promise<void> {
    const body = await readJsonObject(context, deps.maxBodyBytes);
    const { harness, sessionId, displayLabel, workspaceLabel, proofPublicKey } = body;
    if (!exactKeys(body, ['harness', 'sessionId', 'displayLabel', 'workspaceLabel', 'proofPublicKey'])
      || typeof harness !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(harness)
      || typeof sessionId !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(sessionId)
      || !isLabel(displayLabel) || !isLabel(workspaceLabel)
      || typeof proofPublicKey !== 'string' || !KEY_X.test(proofPublicKey)) {
      fail(context, 400, 'invalid_request');
      return;
    }
    const result = await port.issue({ harness, sessionId, displayLabel, workspaceLabel, proofPublicKey });
    if (result.kind === 'issued') {
      sendJson(context.response, 201, {
        v: 1, principal: result.principal, generation: result.generation, discoveryCapability: result.discoveryCapability,
      });
    } else if (result.kind === 'rejected') {
      rejected(context, 409, 'operation_mismatch');
    } else {
      sendUnavailable(context, true);
    }
  }

  async function list(context: RouteContext<Principal>): Promise<void> {
    const keys = [...context.query.keys()];
    const cursors = context.query.getAll('cursor');
    if (keys.some(key => key !== 'cursor') || cursors.length > 1 || (cursors[0] !== undefined && !BOUNDED_TOKEN.test(cursors[0]))) {
      fail(context, 400, 'invalid_request');
      return;
    }
    const result = await port.list(agentOf(context), cursors[0] ?? null);
    if (result.kind === 'listed') sendJson(context.response, 200, result.page);
    else if (result.kind === 'rejected') rejected(context, result.code === 'rate_limited' ? 429 : 410, result.code);
    else sendUnavailable(context, false);
  }

  async function requestAccess(context: RouteContext<Principal>): Promise<void> {
    const agent = agentOf(context);
    const decoded = decodeChannelAccessRequest(await readJsonObject(context, deps.maxBodyBytes), agent.origin);
    if (!decoded.ok) {
      fail(context, 400, 'invalid_request');
      return;
    }
    // The credential reference names the authenticated principal; it is never the capability.
    if (decoded.value.credentialRef !== agent.principal) {
      fail(context, 403, 'forbidden');
      return;
    }
    sendStatus(context, await port.requestAccess(agent, decoded.value));
  }

  async function requestCreate(context: RouteContext<Principal>): Promise<void> {
    const agent = agentOf(context);
    const decoded = decodeChannelCreateIntent(await readJsonObject(context, deps.maxBodyBytes));
    if (!decoded.ok || decoded.value.origin !== agent.origin) {
      fail(context, 400, 'invalid_request');
      return;
    }
    if (decoded.value.credentialRef !== agent.principal) {
      fail(context, 403, 'forbidden');
      return;
    }
    sendStatus(context, await port.requestCreate(agent, decoded.value));
  }

  async function status(context: RouteContext<Principal>, operationKind: 'access' | 'create'): Promise<void> {
    const operationId = context.params.operationId!;
    sendStatus(context, await port.status(agentOf(context), { v: 1, operationId, operationKind }));
  }

  async function exchange(context: RouteContext<Principal>): Promise<void> {
    const agent = agentOf(context);
    const operationId = context.params.operationId!;
    const authorization = context.request.headers.authorization ?? '';
    const accessToken = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
    const proofs = context.request.headersDistinct[DPOP_HEADER];
    const now = deps.clock();
    const jti = proofs?.length === 1 ? checkProof(proofs[0], {
      method: 'POST', url: `${agent.origin}${context.request.url}`, jkt: agent.proofThumbprint, accessToken, nowMs: now,
    }) : null;
    // A discovery capability alone never reaches the exchange: the connector key must sign.
    if (jti === null || !rememberProof(jti, now)) {
      rejected(context, 401, 'proof_required');
      return;
    }
    const decoded = decodeGrantExchangeRequest(await readJsonObject(context, deps.maxBodyBytes));
    if (!decoded.ok) {
      fail(context, 400, 'invalid_request');
      return;
    }
    const result = await port.exchange(agent, operationId, decoded.value);
    if (result.kind === 'ok') sendJson(context.response, 200, result.value);
    else if (result.kind === 'rejected') {
      if (result.code === 'expired' || result.code === 'closed') rejected(context, 410, result.code);
      else if (GRANT_CONFLICTS.has(result.code)) rejected(context, 409, result.code);
      else sendUnavailable(context, true);
    } else sendUnavailable(context, true);
  }

  async function inbox(context: RouteContext<Principal>): Promise<void> {
    const result = await port.inbox(humanOf(context));
    if (result === 'unavailable') sendUnavailable(context, false);
    else sendJson(context.response, 200, { v: 1, requests: result });
  }

  async function decide(context: RouteContext<Principal>, kind: 'access' | 'create'): Promise<void> {
    const decoded = decodeChannelAccessDecisionCommand(await readJsonObject(context, deps.maxBodyBytes));
    if (!decoded.ok || decoded.value.requestHandle !== context.params.requestHandle) {
      fail(context, 400, 'invalid_request');
      return;
    }
    const result = await port.decide(humanOf(context), decoded.value, kind);
    if (result.kind === 'ok') sendJson(context.response, 200, result.value);
    else if (result.kind === 'rejected') {
      const code = result.code;
      rejected(context, code === 'forbidden' ? 403 : code === 'not_found' ? 404 : code === 'expired' || code === 'revoked' ? 410 : 409, code);
    } else sendUnavailable(context, true);
  }

  async function mute(context: RouteContext<Principal>): Promise<void> {
    const decoded = decodeChannelAccessMuteCommand(await readJsonObject(context, deps.maxBodyBytes));
    if (!decoded.ok) {
      fail(context, 400, 'invalid_request');
      return;
    }
    const result = await port.mute(humanOf(context), decoded.value);
    if (result.kind === 'ok') sendJson(context.response, 200, result.value);
    else if (result.kind === 'rejected') {
      rejected(context, result.code === 'forbidden' ? 403 : result.code === 'not_found' ? 404 : 409, result.code);
    } else sendUnavailable(context, true);
  }

  async function settings(context: RouteContext<Principal>): Promise<void> {
    const result = await port.settings(humanOf(context), context.params.channelId!);
    if (result === 'unavailable') sendUnavailable(context, false);
    else if (result === 'not_found') fail(context, 404, 'not_found');
    else sendJson(context.response, 200, result);
  }

  async function updateSettings(context: RouteContext<Principal>): Promise<void> {
    const body = await readJsonObject(context, deps.maxBodyBytes);
    const mutation = readSettingsMutation(body);
    if (!mutation) {
      fail(context, 400, 'invalid_request');
      return;
    }
    const result = await port.updateSettings(humanOf(context), context.params.channelId!, mutation);
    if (result.kind === 'ok') sendJson(context.response, 200, result.value);
    else if (result.kind === 'rejected') rejected(context, result.code === 'not_found' ? 404 : 409, result.code);
    else sendUnavailable(context, true);
  }

  async function agents(context: RouteContext<Principal>): Promise<void> {
    const result = await port.agents(humanOf(context));
    if (result === 'unavailable') sendUnavailable(context, false);
    else sendJson(context.response, 200, { v: 1, agents: result });
  }

  return {
    routes: Object.values(DISCOVERY_ROUTES),
    async handle(context) {
      switch (context.route) {
        case DISCOVERY_ROUTES.issue: return issue(context);
        case DISCOVERY_ROUTES.list: return list(context);
        case DISCOVERY_ROUTES.requestAccess: return requestAccess(context);
        case DISCOVERY_ROUTES.accessStatus: return status(context, 'access');
        case DISCOVERY_ROUTES.requestCreate: return requestCreate(context);
        case DISCOVERY_ROUTES.createStatus: return status(context, 'create');
        case DISCOVERY_ROUTES.exchange: return exchange(context);
        case DISCOVERY_ROUTES.inbox: return inbox(context);
        case DISCOVERY_ROUTES.accessDecision: return decide(context, 'access');
        case DISCOVERY_ROUTES.createDecision: return decide(context, 'create');
        case DISCOVERY_ROUTES.mute: return mute(context);
        case DISCOVERY_ROUTES.settings: return settings(context);
        case DISCOVERY_ROUTES.updateSettings: return updateSettings(context);
        case DISCOVERY_ROUTES.agents: return agents(context);
        default: fail(context, 404, 'not_found');
      }
    },
  };
}

function readSettingsMutation(body: Record<string, unknown>): DiscoverySettingsMutation | null {
  const { operationId, expectedRevision, change } = body;
  if (!exactKeys(body, ['operationId', 'expectedRevision', 'change']) || typeof operationId !== 'string'
    || !BOUNDED_TOKEN.test(operationId) || !Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 0
    || typeof change !== 'object' || change === null || Array.isArray(change)) return null;
  const value = change as Record<string, unknown>;
  if (value.kind === 'visibility') {
    if (!exactKeys(value, ['kind', 'visibility'])
      || (value.visibility !== 'public' && value.visibility !== 'private' && value.visibility !== 'secret')) return null;
    return { operationId, expectedRevision: expectedRevision as number, change: { kind: 'visibility', visibility: value.visibility } };
  }
  if (value.kind === 'allow' || value.kind === 'revoke') {
    if (!exactKeys(value, ['kind', 'principal', 'expectedGeneration']) || !isRouteSegment(value.principal)
      || !Number.isSafeInteger(value.expectedGeneration) || (value.expectedGeneration as number) < 1) return null;
    return {
      operationId,
      expectedRevision: expectedRevision as number,
      change: { kind: value.kind, principal: value.principal, expectedGeneration: value.expectedGeneration as number },
    };
  }
  return null;
}
