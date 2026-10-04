import { type Decoded, type DecodeError, decodeWith, fail, identifier, label, literal, object, utcTimestamp, utf8Length } from '../messaging/decode';
import { validateAgentName } from '../messaging/agent-names';

export type Harness = 'claude' | 'codex' | 'cursor';

// POST /api/agent/join            (no auth; rate-limited per IP)
export type AgentJoinRequest = { link: string; harness: Harness; label: string };   // label 1..40 chars, validateAgentName rules
export type AgentJoinCreated = { joinId: string; pollSecret: string; confirmUrl: string; expiresAt: string; autoConfirmed?: true }; // 201
// errors: 400 invalid_link | invalid_label | invalid_harness ; 404 link_unavailable ; 429 rate_limited

// GET /api/agent/join/poll?joinId=<joinId>      header: Authorization: Bearer <pollSecret>
export type AgentJoinPoll =
  | { state: 'pending' }
  | { state: 'confirmed'; credentials: AgentCredentials }   // returned exactly once
  | { state: 'claimed' }                                     // credentials already taken
  | { state: 'expired' };
// errors: 404 not_found (also for a wrong pollSecret; never 403)

export type AgentCredentials = {
  homeserver: string;      // e.g. "https://127.0.0.1:8443" locally
  userId: string;          // "@agent-1a2b3c4d-x9y8z7:khala.local"
  accessToken: string;
  deviceId: string;        // "KH_AGENT_<uuid8>"
  roomId: string;          // the channel's Matrix room id
  transport?: 'matrix' | 'local'; // absent means matrix
};

// POST /api/agent/join/ready?joinId=<joinId>   header: Authorization: Bearer <pollSecret>
// body: {}  → 204 ; 404 not_found ; 409 not_confirmed

// GET  /api/human/agent-join?joinId=<joinId>          (human session cookie)
export type AgentJoinView = { joinId: string; label: string; harness: Harness; channelName: string; roomId: string;
  state: 'pending' | 'confirmed' | 'ready' | 'expired'; agentUserId?: string };
// errors: 401 signed_out ; 403 not_member ; 404 not_found

// POST /api/human/agent-join/confirm?joinId=<joinId>  (human session cookie + CSRF header as other human POSTs)
// body: {} → 200 AgentJoinView (state 'confirmed', agentUserId set). Idempotent for the same owner; 409 already_confirmed_by_other.

// GET  /api/human/agent-join/status?joinId=<joinId>   → 200 AgentJoinView   (browser polls every 1s until state === 'ready')

/**
 * - **Exact paths only.** The control gateway matches exact paths (`apps/control/src/runtime/handler.ts:9-14`), so `joinId` always travels as a query parameter, never as a path segment.
 * - **Origin header.** Every agent-client POST sends `Origin: <app origin>`, the origin of the channel link. The gateway rejects a POST whose Origin is foreign (`apps/control/src/auth/csrf.ts:14-20`).
 * - **Confirm URL.** The `confirmUrl` is `<app origin>/agent/confirm?joinId=<joinId>`.
 */
export const HARNESSES = ['claude', 'codex', 'cursor'] as const;
export const AGENT_LABEL_MAX_CHARS = 40;
export const M1_LABEL_MAX_BYTES = 512;
export const CHANNEL_LINK_MAX_BYTES = 2048;
const ERROR_CODES = ['invalid_link', 'invalid_label', 'invalid_harness', 'link_unavailable', 'rate_limited', 'not_found', 'not_confirmed', 'signed_out', 'not_member', 'already_confirmed_by_other'] as const;
export type AgentJoinErrorCode = typeof ERROR_CODES[number];
export type AgentJoinError = { error: AgentJoinErrorCode };
export const AGENT_JOIN_PATH = '/api/agent/join';
export const agentJoinPollPath = (id: string): string => `/api/agent/join/poll?joinId=${encodeURIComponent(id)}`;
export const agentJoinReadyPath = (id: string): string => `/api/agent/join/ready?joinId=${encodeURIComponent(id)}`;
export const humanAgentJoinPath = (id: string): string => `/api/human/agent-join?joinId=${encodeURIComponent(id)}`;
export const humanAgentJoinConfirmPath = (id: string): string => `/api/human/agent-join/confirm?joinId=${encodeURIComponent(id)}`;
export const humanAgentJoinStatusPath = (id: string): string => `/api/human/agent-join/status?joinId=${encodeURIComponent(id)}`;
export const agentConfirmPagePath = (id: string): string => `/agent/confirm?joinId=${encodeURIComponent(id)}`;

export function readHarness(input: unknown, path: string): Harness {
  return literal(input, path, HARNESSES);
}

export function readAgentLabel(input: unknown, path: string): string {
  if (typeof input !== 'string') fail(path, 'wrong_type');
  const checked = validateAgentName(input);
  if (!checked.ok || checked.name !== input || [...input].length > AGENT_LABEL_MAX_CHARS) fail(path, 'invalid_value');
  return input;
}

export function readHttpUrl(input: unknown, path: string): string {
  if (typeof input !== 'string') fail(path, 'wrong_type');
  let url: URL;
  try { url = new URL(input); } catch { fail(path, 'invalid_value'); }
  if (url.username || url.password || url.hash
    || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) fail(path, 'invalid_value');
  return input;
}

export function readChannelLink(input: unknown, path: string): string {
  const value = readHttpUrl(input, path);
  const url = new URL(value);
  if (url.href !== value || utf8Length(value) > CHANNEL_LINK_MAX_BYTES || url.search || !/^\/join\/[A-Za-z0-9_-]{8,256}$/u.test(url.pathname)) fail(path, 'invalid_value');
  return value;
}

export function readMatrixUserId(input: unknown, path: string): string {
  const value = identifier(input, path);
  if (!/^@[^\s:]+:\S+$/u.test(value)) fail(path, 'invalid_value');
  return value;
}

export function readRoomId(input: unknown, path: string): string {
  const value = identifier(input, path);
  if (!/^!\S+$/u.test(value)) fail(path, 'invalid_value');
  return value;
}

export function decodeAgentJoinRequest(input: unknown): Decoded<AgentJoinRequest> {
  return decodeWith(() => {
    const r = object(input, '', ['link', 'harness', 'label']);
    return { link: readChannelLink(r.field('link'), r.at('link')), harness: readHarness(r.field('harness'), r.at('harness')), label: readAgentLabel(r.field('label'), r.at('label')) };
  });
}

export function decodeAgentJoinCreated(input: unknown): Decoded<AgentJoinCreated> {
  return decodeWith(() => {
    const auto = typeof input === 'object' && input !== null && Object.hasOwn(input, 'autoConfirmed');
    const r = object(input, '', ['joinId', 'pollSecret', 'confirmUrl', 'expiresAt', ...(auto ? ['autoConfirmed'] : [])]);
    if (auto && r.field('autoConfirmed') !== true) fail(r.at('autoConfirmed'), 'invalid_value');
    const joinId = identifier(r.field('joinId'), r.at('joinId'));
    const confirmUrl = readHttpUrl(r.field('confirmUrl'), r.at('confirmUrl'));
    const url = new URL(confirmUrl);
    const keys = [...url.searchParams.keys()];
    if (url.pathname !== '/agent/confirm' || keys.length !== 1 || keys[0] !== 'joinId' || url.searchParams.get('joinId') !== joinId) fail(r.at('confirmUrl'), 'invalid_value');
    return { joinId, pollSecret: identifier(r.field('pollSecret'), r.at('pollSecret')), confirmUrl, expiresAt: utcTimestamp(r.field('expiresAt'), r.at('expiresAt')), ...(auto ? { autoConfirmed: true as const } : {}) };
  });
}

function readCredentials(input: unknown, path: string): AgentCredentials {
  const transport = typeof input === 'object' && input !== null && Object.hasOwn(input, 'transport');
  const r = object(input, path, ['homeserver', 'userId', 'accessToken', 'deviceId', 'roomId', ...(transport ? ['transport'] : [])]);
  const homeserver = readHttpUrl(r.field('homeserver'), r.at('homeserver'));
  if (new URL(homeserver).origin !== homeserver) fail(r.at('homeserver'), 'invalid_value');
  return {
    homeserver,
    userId: readMatrixUserId(r.field('userId'), r.at('userId')),
    accessToken: identifier(r.field('accessToken'), r.at('accessToken')),
    deviceId: identifier(r.field('deviceId'), r.at('deviceId')),
    roomId: readRoomId(r.field('roomId'), r.at('roomId')),
    ...(transport ? { transport: literal(r.field('transport'), r.at('transport'), ['matrix', 'local']) } : {}),
  };
}

export function decodeAgentCredentials(input: unknown): Decoded<AgentCredentials> {
  return decodeWith(() => readCredentials(input, ''));
}

export function decodeAgentJoinPoll(input: unknown): Decoded<AgentJoinPoll> {
  return decodeWith(() => {
    const state = literal((input as Record<string, unknown> | null)?.['state'], 'state', ['pending', 'confirmed', 'claimed', 'expired']);
    const r = object(input, '', state === 'confirmed' ? ['state', 'credentials'] : ['state']);
    return state === 'confirmed' ? { state, credentials: readCredentials(r.field('credentials'), r.at('credentials')) } : { state };
  });
}

export function decodeAgentJoinView(input: unknown): Decoded<AgentJoinView> {
  return decodeWith(() => {
    const hasAgent = typeof input === 'object' && input !== null && Object.hasOwn(input, 'agentUserId');
    const r = object(input, '', ['joinId', 'label', 'harness', 'channelName', 'roomId', 'state', ...(hasAgent ? ['agentUserId'] : [])]);
    return {
      joinId: identifier(r.field('joinId'), r.at('joinId')),
      label: readAgentLabel(r.field('label'), r.at('label')),
      harness: readHarness(r.field('harness'), r.at('harness')),
      channelName: label(r.field('channelName'), r.at('channelName'), M1_LABEL_MAX_BYTES),
      roomId: readRoomId(r.field('roomId'), r.at('roomId')),
      state: literal(r.field('state'), r.at('state'), ['pending', 'confirmed', 'ready', 'expired']),
      ...(hasAgent ? { agentUserId: readMatrixUserId(r.field('agentUserId'), r.at('agentUserId')) } : {}),
    };
  });
}

export function decodeAgentJoinError(input: unknown): Decoded<AgentJoinError> {
  return decodeWith(() => {
    const r = object(input, '', ['error']);
    return { error: literal(r.field('error'), r.at('error'), ERROR_CODES) };
  });
}

export function agentJoinRequestErrorCode(error: DecodeError): 'invalid_label' | 'invalid_harness' | 'invalid_link' {
  return error.path.startsWith('label') ? 'invalid_label' : error.path.startsWith('harness') ? 'invalid_harness' : 'invalid_link';
}
