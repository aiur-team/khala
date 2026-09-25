import {
  decodeDeviceId,
  decodeRoomId,
  type AdmissionPolicy,
  type AuthPrincipal,
} from '@khala/contracts/messaging/index';
import {
  CALLBACK_PATH,
  LOGIN_PATH,
  type AuthService,
  type MutationAuthorization,
} from '../../auth/index';
import type { AdmissionService } from '../../invitations/index';
import type { RouteRegistration } from '../../runtime/handler';
import type { MatrixSessionIssuer } from './matrix';
import { createProductionHumanServiceLoader } from './production';

export const ME_PATH = '/api/human/me';
export const LOGOUT_PATH = '/api/human/auth/logout';
export const SHARE_PATH = '/api/human/invitations/share';
export const INSPECT_PATH = '/api/human/invitations/inspect';
export const ADMIT_PATH = '/api/human/invitations/admit';
export const MATRIX_SESSION_PATH = '/api/human/messaging/session';
export const MATRIX_PARTICIPANTS_PATH = '/api/human/messaging/participants';

export type HumanHandlerServices = Readonly<{
  /** Request-scoped authentication service backed by the validated runtime configuration. */
  auth: AuthService;
  /** Request-scoped admission service whose IdentityPort is bound to this request. */
  admission: AdmissionService;
  /** Server-side Matrix login boundary. Tokens leave only through its authenticated route. */
  messaging?: MatrixSessionIssuer;
}>;

export type LoadHumanServices = (
  request: Request,
) => HumanHandlerServices | null | Promise<HumanHandlerServices | null>;

const BASE_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'application/json',
  'x-content-type-options': 'nosniff',
} as const;

type JsonObject = Readonly<Record<string, unknown>>;

function json(status: number, value: JsonObject): Response {
  return new Response(JSON.stringify(value), { status, headers: BASE_HEADERS });
}

function unavailable(code: 'feature_unavailable' | 'unavailable' = 'unavailable'): Response {
  return json(503, { code });
}

function redirect(status: 302 | 303, location: string, cookies: readonly string[]): Response {
  const headers = new Headers({
    'cache-control': 'no-store',
    location,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status, headers });
}

function authRejection(result: Exclude<MutationAuthorization, { kind: 'authorized' }>): Response {
  if (result.kind === 'unavailable') return unavailable();
  switch (result.code) {
    case 'signed_out':
      return json(401, { code: 'authentication_required' });
    case 'not_a_mutation':
      return json(405, { code: 'method_not_allowed' });
    case 'forbidden_origin':
      return json(403, { code: 'forbidden_origin' });
    case 'csrf_mismatch':
      return json(403, { code: 'csrf_mismatch' });
  }
}

async function authenticated(auth: AuthService, request: Request): Promise<AuthPrincipal | Response> {
  const result = await auth.authenticateRequest(request);
  if (result.kind === 'unavailable') return unavailable();
  if (result.kind === 'signed_out') return json(401, { code: 'authentication_required' });
  return result.context.principal;
}

async function authorized(auth: AuthService, request: Request): Promise<AuthPrincipal | Response> {
  const result = await auth.requireHumanMutation(request);
  if (result.kind !== 'authorized') return authRejection(result);
  return result.context.principal;
}

function isResponse(value: AuthPrincipal | Response): value is Response {
  return value instanceof Response;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  if ((request.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return null;
  try {
    const value: unknown = await request.json();
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function identifier(value: unknown): string | null {
  return typeof value === 'string' && IDENTIFIER.test(value) ? value : null;
}

function admissionPolicy(value: unknown): AdmissionPolicy | null {
  if (!isPlainObject(value) || value.v !== 1 || typeof value.kind !== 'string' || typeof value.history !== 'string') return null;
  if (value.kind === 'link' && (value.history === 'none' || value.history === 'full')
    && hasExactKeys(value, ['v', 'kind', 'history'])) {
    return { v: 1, kind: 'link', history: value.history };
  }
  if (value.kind === 'named_email' && value.history === 'none' && typeof value.email === 'string'
    && hasExactKeys(value, ['v', 'kind', 'email', 'history'])) {
    return { v: 1, kind: 'named_email', email: value.email, history: 'none' };
  }
  return null;
}

function responseForOperationFailure(
  result: Readonly<{ kind: 'rejected'; code: string }> | Readonly<{ kind: 'unavailable'; retryable: true }> | Readonly<{ kind: 'outcome_unknown'; operationId: string }>,
): Response {
  if (result.kind === 'unavailable') return unavailable();
  if (result.kind === 'outcome_unknown') return json(502, { code: 'outcome_unknown', operationId: result.operationId });
  switch (result.code) {
    case 'auth_required':
      return json(401, { code: 'authentication_required' });
    case 'identity_mismatch':
    case 'forbidden':
      return json(403, { code: 'forbidden' });
    case 'expired':
    case 'revoked':
      return json(410, { code: result.code });
    case 'operation_mismatch':
      return json(409, { code: 'operation_mismatch' });
    default:
      // AdmissionService has a finite rejection union. Keep an unexpected
      // adapter value from turning into a reflected or open-ended error code.
      return unavailable();
  }
}

function defineRoutes(registrations: readonly RouteRegistration[]): readonly RouteRegistration[] {
  const paths = new Set<string>();
  for (const registration of registrations) {
    if (!registration.path.startsWith('/api/human/') || registration.path.includes('*')) {
      throw new Error(`invalid human route path: ${registration.path}`);
    }
    if (paths.has(registration.path)) throw new Error(`duplicate human route path: ${registration.path}`);
    paths.add(registration.path);
    if (registration.methods.length === 0 || new Set(registration.methods).size !== registration.methods.length) {
      throw new Error(`duplicate or empty methods for human route: ${registration.path}`);
    }
  }
  return Object.freeze(registrations.map(registration => Object.freeze({
    ...registration,
    methods: Object.freeze([...registration.methods]),
  })));
}

/**
 * Builds the finite human control surface around a request-scoped service
 * loader. Constructing registrations is pure: the loader is called only from
 * an exact route handler, once for that request.
 */
export function createHumanHandlers(loadServices: LoadHumanServices): readonly RouteRegistration[] {
  async function withServices(
    request: Request,
    handle: (services: HumanHandlerServices) => Promise<Response>,
  ): Promise<Response> {
    let services: HumanHandlerServices | null;
    try {
      services = await loadServices(request);
    } catch {
      return unavailable();
    }
    if (services === null) return unavailable('feature_unavailable');
    try {
      return await handle(services);
    } catch {
      return unavailable();
    }
  }

  const get = Object.freeze(['GET']);
  const post = Object.freeze(['POST']);

  return defineRoutes([
    {
      path: LOGIN_PATH,
      methods: get,
      handle: request => withServices(request, async ({ auth }) => {
        const values = new URL(request.url).searchParams.getAll('return_to');
        if (values.length !== 1) return json(400, { code: 'invalid_request' });
        const result = await auth.startSignIn(values[0]!, request);
        if (result.kind === 'redirect') return redirect(302, result.location, result.cookies);
        if (result.kind === 'unavailable') return unavailable();
        return json(400, { code: result.code });
      }),
    },
    {
      path: CALLBACK_PATH,
      methods: get,
      handle: request => withServices(request, async ({ auth }) => {
        const result = await auth.completeSignIn(request);
        if (result.kind === 'signed_in') return redirect(303, result.location, result.cookies);
        if (result.kind === 'unavailable') {
          const response = unavailable();
          return withCookies(response, result.cookies);
        }
        return withCookies(json(400, { code: result.code }), result.cookies);
      }),
    },
    {
      path: ME_PATH,
      methods: get,
      handle: request => withServices(request, async ({ auth }) => {
        const result = await auth.authenticateRequest(request);
        if (result.kind === 'unavailable') return unavailable();
        if (result.kind === 'signed_out') return json(401, { code: 'authentication_required' });
        return json(200, { principal: result.context.principal, csrfToken: result.context.csrfToken });
      }),
    },
    {
      path: LOGOUT_PATH,
      methods: post,
      handle: request => withServices(request, async ({ auth }) => {
        const authority = await authorized(auth, request);
        if (isResponse(authority)) return authority;
        const value = await readJsonObject(request);
        if (value === null || !hasExactKeys(value, ['operationId'])) return json(400, { code: 'invalid_request' });
        const operationId = identifier(value.operationId);
        if (operationId === null) return json(400, { code: 'invalid_request' });
        const result = await auth.signOut(request, operationId);
        if (result.kind === 'signed_out') return withCookies(json(200, { kind: 'signed_out' }), result.cookies);
        if (result.kind === 'outcome_unknown') return json(502, { code: 'outcome_unknown', operationId: result.operationId });
        if (result.kind === 'unavailable') return unavailable();
        return authRejection(result);
      }),
    },
    {
      path: SHARE_PATH,
      methods: post,
      handle: request => withServices(request, async ({ auth, admission }) => {
        const authority = await authorized(auth, request);
        if (isResponse(authority)) return authority;
        const value = await readJsonObject(request);
        if (value === null || !(hasExactKeys(value, ['operationId', 'roomId'])
          || hasExactKeys(value, ['operationId', 'roomId', 'policy']))) return json(400, { code: 'invalid_request' });
        const operationId = identifier(value.operationId);
        const roomId = decodeRoomId(value.roomId);
        const policy = value.policy === undefined ? undefined : admissionPolicy(value.policy);
        if (operationId === null || !roomId.ok || policy === null) return json(400, { code: 'invalid_request' });
        if (policy?.history === 'full') return json(503, { code: 'history_unavailable' });
        const result = await admission.share({ operationId, roomId: roomId.value, ...(policy ? { policy } : {}) });
        return result.kind === 'ok' ? json(200, result) : responseForOperationFailure(result);
      }),
    },
    {
      path: INSPECT_PATH,
      methods: get,
      handle: request => withServices(request, async ({ auth, admission }) => {
        const authority = await authenticated(auth, request);
        if (isResponse(authority)) return authority;
        const search = new URL(request.url).searchParams;
        const values = search.getAll('invite');
        if (values.length !== 1 || [...search.keys()].some(key => key !== 'invite')) return json(400, { code: 'invalid_request' });
        const inviteRef = identifier(values[0]);
        if (inviteRef === null) return json(400, { code: 'invalid_request' });
        const state = await admission.inspect(inviteRef);
        if (state === 'unavailable') return unavailable();
        if (state === 'auth_required') return json(401, { code: 'authentication_required' });
        return json(200, { state });
      }),
    },
    {
      path: ADMIT_PATH,
      methods: post,
      handle: request => withServices(request, async ({ auth, admission }) => {
        const authority = await authorized(auth, request);
        if (isResponse(authority)) return authority;
        const value = await readJsonObject(request);
        if (value === null || !hasExactKeys(value, ['operationId', 'inviteRef', 'deviceId'])) return json(400, { code: 'invalid_request' });
        const operationId = identifier(value.operationId);
        const inviteRef = identifier(value.inviteRef);
        const deviceId = decodeDeviceId(value.deviceId);
        if (operationId === null || inviteRef === null || !deviceId.ok) return json(400, { code: 'invalid_request' });
        const result = await admission.admit({ operationId, inviteRef, deviceId: deviceId.value });
        return result.kind === 'ok' ? json(200, result) : responseForOperationFailure(result);
      }),
    },
    {
      path: MATRIX_SESSION_PATH,
      methods: post,
      handle: request => withServices(request, async ({ auth, messaging }) => {
        if (!messaging) return unavailable('feature_unavailable');
        const authority = await authorized(auth, request);
        if (isResponse(authority)) return authority;
        const value = await readJsonObject(request);
        if (value === null || !hasExactKeys(value, ['deviceId'])) return json(400, { code: 'invalid_request' });
        const deviceId = decodeDeviceId(value.deviceId);
        if (!deviceId.ok) return json(400, { code: 'invalid_request' });
        const result = await messaging.issue(authority, deviceId.value);
        return result.kind === 'ok' ? json(200, { session: result.session }) : unavailable();
      }),
    },
    {
      path: MATRIX_PARTICIPANTS_PATH,
      methods: post,
      handle: request => withServices(request, async ({ auth, messaging }) => {
        if (!messaging) return unavailable('feature_unavailable');
        const authority = await authorized(auth, request);
        if (isResponse(authority)) return authority;
        const value = await readJsonObject(request);
        if (value === null || !hasExactKeys(value, ['userIds']) || !Array.isArray(value.userIds)
          || value.userIds.length > 100 || value.userIds.some(userId => typeof userId !== 'string' || userId.length > 255)) {
          return json(400, { code: 'invalid_request' });
        }
        const result = await messaging.resolveParticipants(value.userIds as string[]);
        return result.kind === 'ok' ? json(200, { participants: result.participants }) : unavailable();
      }),
    },
  ]);
}

function withCookies(response: Response, cookies: readonly string[]): Response {
  if (cookies.length === 0) return response;
  const headers = new Headers(response.headers);
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Runtime discovery entry point. KHA-132 deliberately fails closed until the
 * deployment composition owner injects the validated Matrix/OIDC services.
 */
const loadProductionServices = createProductionHumanServiceLoader();

export type HumanHandlerDependencies = Readonly<{
  /** Request-lifetime live pairing registrations supplied by the composition root. */
  pairing?: () => readonly RouteRegistration[];
  /** Authenticated channel-access registrations supplied by the composition root. */
  channelAccess?: () => readonly RouteRegistration[];
  /** Request-lifetime discovery-bootstrap registrations supplied by the composition root. */
  channelDiscoveryBootstrap?: () => readonly RouteRegistration[];
  /** Request-lifetime channel-discovery settings registrations supplied by the composition root. */
  channelDiscovery?: () => readonly RouteRegistration[];
}>;

function unavailableRoute(path: string, methods: readonly string[]): RouteRegistration {
  return Object.freeze({
    path,
    methods: Object.freeze(methods),
    async handle() {
      return json(503, { v: 1, kind: 'rejected', code: 'feature_unavailable' });
    },
  });
}

const unavailablePairingRoutes = Object.freeze([
  unavailableRoute('/api/human/pairing/request', ['POST', 'GET']),
  unavailableRoute('/api/human/pairing/decision', ['POST']),
]);

const unavailableChannelAccessRoutes = Object.freeze([
  unavailableRoute('/api/human/channel-access/inbox', ['GET']),
  unavailableRoute('/api/human/channel-access/decision', ['POST']),
  unavailableRoute('/api/human/channel-access/mute', ['POST']),
]);

const unavailableChannelDiscoveryRoutes = Object.freeze([
  Object.freeze({
    path: '/api/human/channel-discovery/bootstrap/authorize',
    methods: Object.freeze(['GET', 'POST']),
    async handle() {
      return json(503, { error: 'feature_unavailable' });
    },
  }),
]);

const unavailableChannelSettingsRoutes = Object.freeze([
  unavailableRoute('/api/human/channel-discovery/settings', ['PUT']),
  unavailableRoute('/api/human/channel-discovery/allowlist', ['POST']),
  unavailableRoute('/api/human/channel-discovery/rollout', ['PUT']),
]);

export function registerHumanHandlers(dependencies?: HumanHandlerDependencies): readonly RouteRegistration[] {
  return Object.freeze([
    ...createHumanHandlers(loadProductionServices),
    ...(dependencies?.pairing?.() ?? unavailablePairingRoutes),
    ...(dependencies?.channelAccess?.() ?? unavailableChannelAccessRoutes),
    ...(dependencies?.channelDiscoveryBootstrap?.() ?? unavailableChannelDiscoveryRoutes),
    ...(dependencies?.channelDiscovery?.() ?? unavailableChannelSettingsRoutes),
  ]);
}
