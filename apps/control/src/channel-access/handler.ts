import {
  decodeChannelAccessDecisionCommand,
  decodeChannelAccessMuteCommand,
  decodeChannelAccessOwnerProjection,
  decodeChannelAccessRequest,
  decodeChannelAccessStatusQuery,
  decodeChannelCreateIntent,
  type ChannelAccessRequesterContext,
  type DiscoveryRequester,
} from '@khala/contracts/messaging/index';
import type { AuthService } from '../auth';
import type { RouteRegistration } from '../runtime/handler';
import type { ChannelAccessService } from './service';

export const AGENT_CHANNEL_ACCESS_REQUEST_PATH = '/api/agent/channel-access/request';
export const AGENT_CHANNEL_ACCESS_CREATE_PATH = '/api/agent/channel-access/create';
export const AGENT_CHANNEL_ACCESS_STATUS_PATH = '/api/agent/channel-access/status';
export const HUMAN_CHANNEL_ACCESS_INBOX_PATH = '/api/human/channel-access/inbox';
export const HUMAN_CHANNEL_ACCESS_DECISION_PATH = '/api/human/channel-access/decision';
export const HUMAN_CHANNEL_ACCESS_MUTE_PATH = '/api/human/channel-access/mute';

export type AgentChannelAccessAuthentication =
  | Readonly<{ kind: 'authenticated'; requester: DiscoveryRequester; context: ChannelAccessRequesterContext }>
  | Readonly<{ kind: 'rejected'; code: 'auth_required' | 'forbidden' }>
  | Readonly<{ kind: 'unavailable' }>;

export type ChannelAccessHandlerDependencies = Readonly<{
  service: Pick<ChannelAccessService, 'journal' | 'decisions'>;
  auth: Pick<AuthService, 'authenticateRequest' | 'requireHumanMutation'>;
  /** Composition verifies both values; caller JSON can never supply either one. */
  authenticateAgent(request: Request): Promise<AgentChannelAccessAuthentication>;
}>;

export type ChannelAccessHandlers = Readonly<{
  agent: readonly RouteRegistration[];
  human: readonly RouteRegistration[];
}>;

export function createChannelAccessHandlers(deps: ChannelAccessHandlerDependencies): ChannelAccessHandlers {
  async function agentContext(request: Request): Promise<Extract<AgentChannelAccessAuthentication, { kind: 'authenticated' }> | Response> {
    const auth = await safeCall(() => deps.authenticateAgent(request));
    if (auth === null || auth.kind === 'unavailable') return unavailable();
    if (auth.kind === 'rejected') {
      return rejected(auth.code === 'auth_required' ? 401 : 403, auth.code);
    }
    return auth;
  }

  async function requestAccess(request: Request): Promise<Response> {
    const authenticated = await agentContext(request);
    if (authenticated instanceof Response) return authenticated;
    const body = decodeChannelAccessRequest(await readJson(request), authenticated.requester.origin);
    if (!body.ok) return rejected(400, 'invalid_request');
    const result = await safeCall(() => deps.service.journal.requestAccess(
      body.value, authenticated.requester, authenticated.context,
    ));
    return result === null ? unavailable() : json(200, projectStatus(result));
  }

  async function requestCreate(request: Request): Promise<Response> {
    const authenticated = await agentContext(request);
    if (authenticated instanceof Response) return authenticated;
    const body = decodeChannelCreateIntent(await readJson(request));
    if (!body.ok) return rejected(400, 'invalid_request');
    const result = await safeCall(() => deps.service.journal.requestCreate(
      body.value, authenticated.requester, authenticated.context,
    ));
    return result === null ? unavailable() : json(200, projectStatus(result));
  }

  async function inspect(request: Request): Promise<Response> {
    const authenticated = await agentContext(request);
    if (authenticated instanceof Response) return authenticated;
    const query = readStatusQuery(request);
    if (!query.ok) return rejected(400, 'invalid_request');
    const result = await safeCall(() => deps.service.journal.inspect(
      query.value, authenticated.requester, authenticated.context,
    ));
    return result === null ? unavailable() : json(200, projectStatus(result));
  }

  async function inbox(request: Request): Promise<Response> {
    const authentication = await safeCall(() => deps.auth.authenticateRequest(request));
    if (authentication === null || authentication.kind === 'unavailable') return unavailable();
    if (authentication.kind === 'signed_out') return rejected(401, 'signed_out');
    const result = await safeCall(() => deps.service.decisions.inbox(authentication.context.principal));
    if (result === null || result.kind !== 'ok') return unavailable();
    const requests = [];
    for (const item of result.value) {
      const decoded = decodeChannelAccessOwnerProjection(item);
      if (!decoded.ok) return unavailable();
      requests.push(decoded.value);
    }
    return json(200, { v: 1, kind: 'ok', requests });
  }

  async function decide(request: Request): Promise<Response> {
    const authorization = await humanMutation(request);
    if (authorization instanceof Response) return authorization;
    const body = decodeChannelAccessDecisionCommand(await readJson(request));
    if (!body.ok) return rejected(400, 'invalid_request');
    const result = await safeCall(() => deps.service.decisions.decide(body.value, authorization.principal));
    if (result === null) return unavailable();
    if (result.kind === 'ok') {
      const decoded = decodeChannelAccessOwnerProjection(result.value);
      return decoded.ok ? json(200, decoded.value) : unavailable();
    }
    return mapDecisionResult(result);
  }

  async function setMute(request: Request): Promise<Response> {
    const authorization = await humanMutation(request);
    if (authorization instanceof Response) return authorization;
    const body = decodeChannelAccessMuteCommand(await readJson(request));
    if (!body.ok) return rejected(400, 'invalid_request');
    const result = await safeCall(() => deps.service.decisions.setMute(body.value, authorization.principal));
    if (result === null) return unavailable();
    if (result.kind === 'ok') {
      return json(200, {
        v: 1,
        operationKind: result.value.operationKind,
        muted: result.value.muted,
        revision: result.value.revision,
      });
    }
    return mapDecisionResult(result);
  }

  async function humanMutation(request: Request) {
    const authorization = await safeCall(() => deps.auth.requireHumanMutation(request));
    if (authorization === null || authorization.kind === 'unavailable') return unavailable();
    if (authorization.kind === 'rejected') {
      return authorization.code === 'signed_out'
        ? rejected(401, 'signed_out')
        : rejected(403, 'forbidden');
    }
    return authorization.context;
  }

  const agent = Object.freeze([
    registration(AGENT_CHANNEL_ACCESS_REQUEST_PATH, ['POST'], requestAccess),
    registration(AGENT_CHANNEL_ACCESS_CREATE_PATH, ['POST'], requestCreate),
    registration(AGENT_CHANNEL_ACCESS_STATUS_PATH, ['GET'], inspect),
  ]);
  const human = Object.freeze([
    registration(HUMAN_CHANNEL_ACCESS_INBOX_PATH, ['GET'], inbox),
    registration(HUMAN_CHANNEL_ACCESS_DECISION_PATH, ['POST'], decide),
    registration(HUMAN_CHANNEL_ACCESS_MUTE_PATH, ['POST'], setMute),
  ]);
  return Object.freeze({ agent, human });
}

function registration(path: string, methods: readonly string[], handle: RouteRegistration['handle']): RouteRegistration {
  return Object.freeze({ path, methods: Object.freeze(methods), handle });
}

function readStatusQuery(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const fields = ['v', 'operationId', 'operationKind'] as const;
    if ([...params.keys()].some(key => !fields.includes(key as typeof fields[number]))) {
      return decodeChannelAccessStatusQuery(undefined);
    }
    if (fields.some(field => params.getAll(field).length !== 1)) return decodeChannelAccessStatusQuery(undefined);
    return decodeChannelAccessStatusQuery({
      v: params.get('v') === '1' ? 1 : params.get('v'),
      operationId: params.get('operationId'),
      operationKind: params.get('operationKind'),
    });
  } catch {
    return decodeChannelAccessStatusQuery(undefined);
  }
}

function projectStatus(input: Readonly<{ v: 1; operationId: string; outcome: string }>) {
  return { v: 1, operationId: input.operationId, outcome: input.outcome };
}

function mapDecisionResult(result: Readonly<{ kind: string; code?: string }>): Response {
  if (result.kind === 'unavailable' || result.kind === 'outcome_unknown') return unavailable();
  const code = result.code;
  if (code === 'forbidden' || code === 'not_found') return rejected(404, 'not_found');
  if (code === 'stale_revision' || code === 'decision_conflict' || code === 'expired'
    || code === 'revoked' || code === 'operation_mismatch') return rejected(409, code);
  return unavailable();
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
