import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EventRef, SessionBinding } from '@khala/contracts/delivery/index';
import {
  type ContentLimits, type DeviceId, type EventId, MAX_CHANNEL_TITLE_BYTES, type ParticipantId, type RoomId,
  decodeContentLimits, decodeMessageContent,
} from '@khala/contracts/messaging/index';
import type { ChannelStore, StoredChannel, StoredEvent } from '../store/channel-store';
import { type MakeExternalJourneyPort, createMakeExternalRoutes, isMakeExternalRoute } from './make-external';
import { type AssetLimits, type AssetManifest, type AssetTable, DEFAULT_ASSET_LIMITS, loadAssets } from './assets';
import {
  BOOTSTRAP_DOCUMENT, BOOTSTRAP_DOCUMENT_ROUTE, BOOTSTRAP_SCRIPT, BOOTSTRAP_SCRIPT_ROUTE, REQUEST_SECRET_HEADER,
  SESSION_COOKIE, SESSION_EXCHANGE_ROUTE,
} from './bootstrap';
import {
  type BindingCredential, type BootstrapCredential, type CredentialAuthority, CredentialConfigError, type Principal,
  createCredentialAuthority, mintCredential,
} from './credentials';
import { type InternalDiscoveryPort, createDiscoveryRoutes, discoveryRole } from './discovery';
import {
  BodyError, type ErrorCode, applySecurityHeaders, headerValues, readJsonObject, sendBytes, sendError, sendJson,
} from './http';
import {
  type AuthOutcome, DEFAULT_LIMITS, type LogEvent, type LoopbackServer, type RouteContext, type RouteSpec, isRouteSegment,
  type ServerLimits, startLoopbackServer,
} from './server';

export type ChannelServerLimits = ServerLimits & AssetLimits & Readonly<{
  maxSessions: number;
  maxStreams: number;
  maxStreamsPerCredential: number;
  keepaliveMs: number;
  maxMessageBytes: number;
  maxPageLimit: number;
  maxCursorBytes: number;
  maxOperationIdBytes: number;
  maxBootstrapBodyBytes: number;
}>;

export const DEFAULT_CHANNEL_SERVER_LIMITS: ChannelServerLimits = {
  ...DEFAULT_LIMITS,
  ...DEFAULT_ASSET_LIMITS,
  maxSessions: 16,
  maxStreams: 16,
  maxStreamsPerCredential: 4,
  keepaliveMs: 15_000,
  maxMessageBytes: 16 * 1024,
  maxPageLimit: 100,
  maxCursorBytes: 512,
  maxOperationIdBytes: 128,
  maxBootstrapBodyBytes: 512,
};

/** One release for a binding's inbox: canonical release bytes and the exact events they carry. */
export type AgentRelease = Readonly<{
  releaseId: string;
  events: readonly EventRef[];
  payload: Uint8Array;
  payloadDigest: string;
  releasedAt: string;
  /** False when the listening mode or the author forbids hinting the harness. */
  wake: boolean;
}>;

export type AgentReleaseRead =
  | Readonly<{ kind: 'page'; releases: readonly AgentRelease[]; nextCursor: string; caughtUp: boolean }>
  | Readonly<{ kind: 'held'; reason: 'paused' | 'mode_unavailable' }>
  | Readonly<{ kind: 'rejected'; code: string }>
  | Readonly<{ kind: 'unavailable' }>;

/** Composition-supplied pull source of one binding's releases in one channel. */
export type AgentReleaseFeed = Readonly<{
  read(input: Readonly<{ binding: SessionBinding; channelId: RoomId; cursor: string | null; limit: number }>): AgentReleaseRead;
}>;

export type ChannelServerOptions = Readonly<{
  store: ChannelStore;
  bootstrap: readonly BootstrapCredential[];
  bindings: readonly BindingCredential[];
  /** Serves `GET .../releases` to binding principals; the route is absent without it. */
  releases?: AgentReleaseFeed;
  /** The launch's transport capability; with `discovery`, it may only ask for a discovery descriptor. */
  transportCapability?: string;
  /** Channel discovery, access requests and the connector exchange. Absent means those routes do not exist. */
  discovery?: InternalDiscoveryPort;
  /** The human's Make-external journey. Absent means its routes do not exist and the browser offers no action. */
  makeExternal?: MakeExternalJourneyPort;
  assets?: AssetManifest;
  newId: () => string;
  clock: () => number;
  log?: (event: LogEvent) => void;
  startPort?: number;
  limits?: Partial<ChannelServerLimits>;
}>;

const ROUTES = {
  bootstrapDocument: { method: 'GET', path: BOOTSTRAP_DOCUMENT_ROUTE, admission: 'public' },
  bootstrapScript: { method: 'GET', path: BOOTSTRAP_SCRIPT_ROUTE, admission: 'public' },
  exchange: { method: 'POST', path: SESSION_EXCHANGE_ROUTE, admission: 'bootstrap' },
  session: { method: 'GET', path: '/api/v1/session', admission: 'authenticated' },
  create: { method: 'POST', path: '/api/v1/channels', admission: 'authenticated' },
  channel: { method: 'GET', path: '/api/v1/channels/:channelId', admission: 'authenticated' },
  timeline: { method: 'GET', path: '/api/v1/channels/:channelId/timeline', admission: 'authenticated', allowQuery: true },
  send: { method: 'POST', path: '/api/v1/channels/:channelId/messages', admission: 'authenticated' },
  hints: { method: 'GET', path: '/api/v1/channels/:channelId/hints', admission: 'authenticated' },
  binding: { method: 'GET', path: '/api/v1/agent/binding', admission: 'authenticated' },
  releases: { method: 'GET', path: '/api/v1/channels/:channelId/releases', admission: 'authenticated', allowQuery: true },
  channelDocument: { method: 'GET', path: '/channels/:channelId', admission: 'public' },
  /** The same application document, so a reload of the Make-external page resumes it. */
  makeExternalDocument: { method: 'GET', path: '/channels/:channelId/make-external', admission: 'public' },
} as const satisfies Record<string, RouteSpec>;

const TOKEN = /^[\x21-\x7e]+$/;
const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/;

type Failure = Readonly<{ status: number; code: ErrorCode }>;

function failure(status: number, code: ErrorCode): Failure {
  return { status, code };
}

function fail(response: ServerResponse, outcome: Failure): void {
  sendError(response, outcome.status, outcome.code);
}

function rejection(code: string): Failure {
  switch (code) {
    case 'identity_mismatch':
    case 'read_only': return failure(403, 'forbidden');
    case 'not_found': return failure(404, 'not_found');
    case 'not_joined': return failure(403, 'not_joined');
    case 'operation_mismatch': return failure(409, 'operation_mismatch');
    case 'invalid_cursor': return failure(400, 'invalid_cursor');
    default: return failure(400, 'invalid_request');
  }
}

/** A binding that is no longer the live generation is unauthenticated, never merely rejected. */
function releaseRejection(code: string): Failure {
  switch (code) {
    case 'stale_binding':
    case 'binding_mismatch':
    case 'binding_revoked': return failure(401, 'unauthenticated');
    default: return rejection(code);
  }
}

function channelView(channel: StoredChannel) {
  return { channelId: channel.channelId, title: channel.title, membership: channel.membership, revision: channel.revision };
}

function eventView(event: StoredEvent) {
  return {
    eventId: event.eventId,
    channelId: event.channelId,
    authorDeviceId: event.authorDeviceId,
    participant: event.participant,
    content: event.content,
    clientTxnId: event.clientTxnId,
    receivedAt: event.receivedAt,
  };
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function boundedToken(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && TOKEN.test(value) && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function actor(principal: Principal): Readonly<{ participantId: ParticipantId; deviceId: DeviceId }> {
  if (principal.kind === 'human') return { participantId: principal.human.participantId, deviceId: principal.human.deviceId };
  if (principal.kind === 'binding') return { participantId: principal.binding.agentParticipantId, deviceId: principal.binding.deviceId };
  // Channel routes admit only human and binding principals; see `admits`.
  throw new Error('channel route reached without a channel principal');
}

/** Channel content routes: the creating human, or the human and bound agents. */
function admits(route: RouteSpec, principal: Principal): boolean {
  const role = discoveryRole(route);
  if (role !== null) return role === principal.kind;
  if (route === ROUTES.create || isMakeExternalRoute(route)) return principal.kind === 'human';
  return principal.kind === 'human' || principal.kind === 'binding';
}

function parseSessionCookie(request: IncomingMessage): string | null | 'ambiguous' {
  const headers = headerValues(request, 'cookie');
  if (headers.length === 0) return null;
  if (headers.length > 1) return 'ambiguous';
  const values = headers[0]!.split(';').map(part => part.trim()).filter(part => part.startsWith(`${SESSION_COOKIE}=`));
  if (values.length === 0) return null;
  return values.length === 1 ? values[0]!.slice(SESSION_COOKIE.length + 1) : 'ambiguous';
}

export async function startChannelServer(options: ChannelServerOptions): Promise<LoopbackServer> {
  const limits: ChannelServerLimits = { ...DEFAULT_CHANNEL_SERVER_LIMITS, ...options.limits };
  const { store } = options;
  // Assets and credentials are validated before any socket is bound.
  const scopedChannels = [...options.bootstrap.map(record => record.channelId), ...options.bindings.flatMap(record => record.channels)];
  if (!scopedChannels.every(isRouteSegment)) throw new CredentialConfigError();
  const assets: AssetTable | null = options.assets ? loadAssets(options.assets, limits) : null;
  const authority: CredentialAuthority = createCredentialAuthority({
    bootstrap: options.bootstrap,
    bindings: options.bindings,
    ...(options.transportCapability === undefined ? {} : { transportCapability: options.transportCapability }),
    clock: options.clock,
    maxSessions: limits.maxSessions,
  });
  const contentLimits = decodeContentLimits({
    maxBodyBytes: limits.maxMessageBytes,
    maxDisplayNameBytes: 1,
    maxRoomTitleBytes: MAX_CHANNEL_TITLE_BYTES,
  });
  if (!contentLimits.ok) throw new Error('loopback server: invalid limits');
  const messageLimits: ContentLimits = contentLimits.value;
  const streams = new Map<string, number>();
  let totalStreams = 0;

  const routes: RouteSpec[] = [
    ROUTES.bootstrapDocument, ROUTES.bootstrapScript, ROUTES.exchange,
    ROUTES.session, ROUTES.create, ROUTES.channel, ROUTES.timeline, ROUTES.send, ROUTES.hints, ROUTES.binding,
  ];
  if (options.releases) routes.push(ROUTES.releases);
  let origin = '';
  const discovery = options.discovery
    ? createDiscoveryRoutes({
      port: options.discovery,
      origin: () => origin,
      clock: options.clock,
      maxBodyBytes: limits.maxBodyBytes,
      // A binding activated through channel access takes effect in this running server.
      installBinding({ binding, channelId }) {
        if (!isRouteSegment(channelId)) return null;
        const credential = mintCredential();
        return authority.installBinding({ credential, binding, channels: [channelId] }) ? credential : null;
      },
    })
    : null;
  if (discovery) routes.push(...discovery.routes);
  const makeExternal = options.makeExternal
    ? createMakeExternalRoutes({ journey: options.makeExternal, maxBodyBytes: limits.maxBodyBytes })
    : null;
  if (makeExternal) routes.push(...makeExternal.routes);
  if (assets?.channelDocument) routes.push(ROUTES.channelDocument);
  if (assets?.channelDocument && makeExternal) routes.push(ROUTES.makeExternalDocument);
  for (const route of assets?.routes ?? []) routes.push({ method: 'GET', path: route, template: 'asset', admission: 'public' });

  /**
   * Revalidates a binding against the durable store on every use: the exact row
   * must be active and still the newest generation for its binding ID.
   */
  function bindingLive(principal: Principal): 'live' | 'revoked' | 'unavailable' {
    if (principal.kind !== 'binding') return 'live';
    const result = store.binding(principal.binding);
    const latest = store.latestBindingGeneration(principal.binding.bindingId);
    if (result.kind === 'unavailable' || latest.kind === 'unavailable') return 'unavailable';
    return result.kind === 'done' && result.binding.status === 'active' && latest.generation === principal.binding.generation
      ? 'live'
      : 'revoked';
  }

  /** Rechecks authority after a body arrives, immediately before a durable write. */
  function stillLive(context: RouteContext<Principal>): boolean {
    const live = bindingLive(context.principal!);
    if (live === 'live') return true;
    fail(context.response, live === 'unavailable' ? failure(503, 'unavailable') : failure(401, 'unauthenticated'));
    return false;
  }

  async function authenticate(
    request: IncomingMessage,
    route: RouteSpec,
    params: Readonly<Record<string, string>>,
  ): Promise<AuthOutcome<Principal>> {
    const authorization = headerValues(request, 'authorization');
    const cookie = parseSessionCookie(request);
    const secrets = headerValues(request, REQUEST_SECRET_HEADER);
    if (cookie === 'ambiguous' || authorization.length > 1 || secrets.length > 1
      || (authorization.length === 1 && (cookie !== null || secrets.length > 0))) {
      return { ok: false, status: 401, code: 'unauthenticated' };
    }
    let principal: Principal | null = null;
    if (authorization.length === 1) {
      const token = BEARER.exec(authorization[0]!)?.[1];
      principal = token ? authority.authenticateBearer(token) ?? authority.authenticateTransport(token) : null;
      if (token && !principal && options.discovery) {
        let agent: Awaited<ReturnType<InternalDiscoveryPort['authenticate']>>;
        try {
          agent = await options.discovery.authenticate(token);
        } catch {
          agent = 'unavailable';
        }
        if (agent === 'unavailable') return { ok: false, status: 503, code: 'unavailable' };
        if (agent) principal = { kind: 'discovery', sessionKey: `discovery:${agent.principal}:${agent.generation}`, agent };
      }
    } else if (cookie !== null && secrets.length === 1) {
      principal = authority.authenticateSession(cookie, secrets[0]!);
    }
    if (!principal) return { ok: false, status: 401, code: 'unauthenticated' };
    if (!admits(route, principal)) return { ok: false, status: 403, code: 'forbidden' };
    try {
      const live = bindingLive(principal);
      if (live === 'unavailable') return { ok: false, status: 503, code: 'unavailable' };
      if (live === 'revoked') return { ok: false, status: 401, code: 'unauthenticated' };
    } catch {
      return { ok: false, status: 503, code: 'unavailable' };
    }
    const channelId = params.channelId as RoomId | undefined;
    if (principal.kind === 'binding' && channelId !== undefined && !principal.channels.has(channelId)) {
      return { ok: false, status: 403, code: 'forbidden' };
    }
    return { ok: true, principal };
  }

  async function exchange(context: RouteContext<Principal>): Promise<void> {
    const { response } = context;
    const body = await readJsonObject(context, limits.maxBootstrapBodyBytes);
    if (!exactKeys(body, ['credential', 'channelId'])) {
      fail(response, failure(400, 'invalid_request'));
      return;
    }
    const outcome = authority.exchangeBootstrap({ credential: body.credential, channelId: body.channelId });
    if (!outcome.ok) {
      fail(response, outcome.reason === 'session_limit' ? failure(503, 'too_many_requests') : failure(401, 'unauthenticated'));
      return;
    }
    sendJson(response, 200, {
      requestSecret: outcome.session.requestSecret,
      route: `/channels/${encodeURIComponent(outcome.session.channelId)}`,
    }, {
      // Host-only (no Domain); `__Host-` would require Secure, which plain loopback HTTP cannot carry.
      'set-cookie': `${SESSION_COOKIE}=${outcome.session.cookie}; Path=/; HttpOnly; SameSite=Strict`,
    });
  }

  async function create(context: RouteContext<Principal>): Promise<void> {
    const { principal, response } = context;
    if (principal?.kind !== 'human') {
      fail(response, failure(403, 'forbidden'));
      return;
    }
    const body = await readJsonObject(context, limits.maxBodyBytes);
    const title = body.title;
    if (!exactKeys(body, ['operationId', 'title']) || !boundedToken(body.operationId, limits.maxOperationIdBytes)
      || !(title === null || (typeof title === 'string' && title.length > 0
        && Buffer.byteLength(title, 'utf8') <= MAX_CHANNEL_TITLE_BYTES && !/[\p{Cc}]/u.test(title)))) {
      fail(response, failure(400, 'invalid_request'));
      return;
    }
    const newChannelId = options.newId();
    // Channel IDs must stay addressable as a route segment, or the channel becomes unreachable.
    if (!isRouteSegment(newChannelId)) throw new Error('loopback server: unroutable channel id');
    const result = store.createChannel({
      operationId: body.operationId,
      channelId: newChannelId as RoomId,
      title,
      creatorOwnerId: principal.human.ownerId,
      creatorParticipantId: principal.human.participantId,
      creatorDeviceId: principal.human.deviceId,
      createdAt: new Date(options.clock()).toISOString(),
    });
    if (result.kind === 'created' || result.kind === 'replayed') {
      sendJson(response, result.kind === 'created' ? 201 : 200, { channel: channelView(result.channel) });
    } else if (result.kind === 'rejected') {
      fail(response, rejection(result.code));
    } else {
      // An unavailable write may or may not have committed; never report success.
      fail(response, failure(503, 'outcome_unknown'));
    }
  }

  /** Lets the local browser learn the human authority its session was bootstrapped with. */
  function session({ principal, response }: RouteContext<Principal>): void {
    if (principal?.kind !== 'human') {
      fail(response, failure(403, 'forbidden'));
      return;
    }
    const { ownerId, participantId, deviceId } = principal.human;
    sendJson(response, 200, { human: { ownerId, participantId, deviceId } });
  }

  /** Lets a local agent client learn the exact live binding its capability holds. */
  function binding({ principal, response }: RouteContext<Principal>): void {
    if (principal?.kind !== 'binding') {
      fail(response, failure(403, 'forbidden'));
      return;
    }
    const held = principal.binding;
    sendJson(response, 200, {
      binding: {
        v: held.v, bindingId: held.bindingId, ownerId: held.ownerId, agentParticipantId: held.agentParticipantId,
        deviceId: held.deviceId, harness: held.harness, sessionId: held.sessionId, generation: held.generation,
      },
    });
  }

  function channel({ principal, params, response }: RouteContext<Principal>): void {
    const channelId = params.channelId as RoomId;
    const read = store.channel({ channelId, participantId: actor(principal!).participantId });
    if (read.kind !== 'done') {
      fail(response, read.kind === 'rejected' ? rejection(read.code) : failure(503, 'unavailable'));
      return;
    }
    const roster = store.roster(channelId);
    if (roster.kind !== 'done') {
      fail(response, roster.kind === 'rejected' ? rejection(roster.code) : failure(503, 'unavailable'));
      return;
    }
    sendJson(response, 200, { channel: channelView(read.channel), participants: roster.participants });
  }

  /** `?cursor=&limit=` and nothing else; null when malformed or over the page limit. */
  function pageQuery(query: URLSearchParams): Readonly<{ cursor: string | null; limit: number }> | null {
    const keys = [...query.keys()];
    const cursors = query.getAll('cursor');
    const limitValues = query.getAll('limit');
    if (keys.some(key => key !== 'cursor' && key !== 'limit') || cursors.length > 1 || limitValues.length > 1
      || (cursors[0] !== undefined && !boundedToken(cursors[0], limits.maxCursorBytes))
      || (limitValues[0] !== undefined && !/^[1-9]\d{0,3}$/.test(limitValues[0]))) {
      return null;
    }
    const limit = limitValues[0] === undefined ? 50 : Number(limitValues[0]);
    return limit > limits.maxPageLimit ? null : { cursor: cursors[0] ?? null, limit };
  }

  function timeline({ principal, params, query, response }: RouteContext<Principal>): void {
    const page = pageQuery(query);
    if (page === null) {
      fail(response, failure(400, 'invalid_request'));
      return;
    }
    const result = store.timeline({
      channelId: params.channelId as RoomId,
      participantId: actor(principal!).participantId,
      cursor: page.cursor,
      limit: page.limit,
    });
    if (result.kind === 'done') {
      sendJson(response, 200, { events: result.events.map(eventView), nextCursor: result.nextCursor, revision: result.revision });
    } else {
      fail(response, result.kind === 'rejected' ? rejection(result.code) : failure(503, 'unavailable'));
    }
  }

  /**
   * Pulls the held binding's next releases. The reply names the exact binding
   * generation it was read for, so the client can fence its inbox on it.
   */
  function releases({ principal, params, query, response }: RouteContext<Principal>): void {
    if (principal?.kind !== 'binding' || !options.releases) {
      fail(response, failure(403, 'forbidden'));
      return;
    }
    const page = pageQuery(query);
    if (page === null) {
      fail(response, failure(400, 'invalid_request'));
      return;
    }
    const held = principal.binding;
    const result = options.releases.read({ binding: held, channelId: params.channelId as RoomId, ...page });
    const identity = { bindingId: held.bindingId, generation: held.generation };
    switch (result.kind) {
      case 'page':
        sendJson(response, 200, {
          v: 1,
          binding: identity,
          releases: result.releases.map(release => ({
            releaseId: release.releaseId,
            events: release.events,
            payloadDigest: release.payloadDigest,
            payloadBase64: Buffer.from(release.payload).toString('base64'),
            releasedAt: release.releasedAt,
            wake: release.wake,
          })),
          nextCursor: result.nextCursor,
          caughtUp: result.caughtUp,
          held: null,
        });
        return;
      case 'held':
        // The cursor is echoed unchanged: held work stays behind it.
        sendJson(response, 200, { v: 1, binding: identity, releases: [], nextCursor: page.cursor, caughtUp: false, held: result.reason });
        return;
      case 'rejected':
        fail(response, releaseRejection(result.code));
        return;
      default:
        fail(response, failure(503, 'unavailable'));
    }
  }

  async function send(context: RouteContext<Principal>): Promise<void> {
    const { principal, params, response } = context;
    const body = await readJsonObject(context, limits.maxBodyBytes);
    const content = decodeMessageContent(body.content, messageLimits);
    // Attribution is never read from JSON: any extra key is an invalid shape.
    if (!exactKeys(body, ['clientTxnId', 'content']) || !boundedToken(body.clientTxnId, limits.maxOperationIdBytes) || !content.ok) {
      fail(response, failure(400, 'invalid_request'));
      return;
    }
    if (!stillLive(context)) return;
    const author = actor(principal!);
    const result = store.send({
      channelId: params.channelId as RoomId,
      eventId: options.newId() as EventId,
      authorParticipantId: author.participantId,
      authorDeviceId: author.deviceId,
      clientTxnId: body.clientTxnId,
      content: content.value,
      receivedAt: new Date(options.clock()).toISOString(),
    });
    if (result.kind === 'stored' || result.kind === 'replayed') {
      sendJson(response, result.kind === 'stored' ? 201 : 200, { state: result.kind, event: eventView(result.event) });
    } else if (result.kind === 'rejected') {
      fail(response, rejection(result.code));
    } else {
      fail(response, failure(503, 'outcome_unknown'));
    }
  }

  function hints({ principal, params, request, response, detach, signal }: RouteContext<Principal>): void {
    const who = principal!;
    const channelId = params.channelId as RoomId;
    const access = store.channel({ channelId, participantId: actor(who).participantId });
    if (access.kind !== 'done') {
      fail(response, access.kind === 'rejected' ? rejection(access.code) : failure(503, 'unavailable'));
      return;
    }
    const own = streams.get(who.sessionKey) ?? 0;
    if (totalStreams >= limits.maxStreams || own >= limits.maxStreamsPerCredential) {
      response.setHeader('retry-after', '5');
      fail(response, failure(429, 'too_many_requests'));
      return;
    }
    totalStreams += 1;
    streams.set(who.sessionKey, own + 1);
    detach();

    let open = true;
    let unsubscribe = () => {};
    let keepalive: NodeJS.Timeout | undefined;
    // Registered before anything can throw, so the stream slot is always released.
    const cleanup = () => {
      if (!open) return;
      open = false;
      unsubscribe();
      clearInterval(keepalive);
      signal.removeEventListener('abort', cleanup);
      totalStreams -= 1;
      const remaining = (streams.get(who.sessionKey) ?? 1) - 1;
      if (remaining === 0) streams.delete(who.sessionKey);
      else streams.set(who.sessionKey, remaining);
      if (!response.writableEnded) response.end();
    };
    request.once('close', cleanup);
    response.once('close', cleanup);
    signal.addEventListener('abort', cleanup, { once: true });
    // Binding liveness and channel membership are both rechecked before every frame.
    const stillAuthorized = () => {
      try {
        if (bindingLive(who) === 'live'
          && store.channel({ channelId, participantId: actor(who).participantId }).kind === 'done') return true;
      } catch { /* Treated as unauthorized below. */ }
      cleanup();
      return false;
    };
    try {
      unsubscribe = store.subscribeHints(channelId, () => {
        if (open && stillAuthorized()) response.write('event: hint\ndata: {}\n\n');
      });
      keepalive = setInterval(() => {
        if (open && stillAuthorized()) response.write(': keepalive\n\n');
      }, limits.keepaliveMs);
      keepalive.unref();
      applySecurityHeaders(response);
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'x-accel-buffering': 'no',
      });
      // `ready` tells a new or reconnected client to reread authenticated durable state.
      response.write('retry: 2000\n\nevent: ready\ndata: {}\n\n');
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  function staticAsset({ route, response }: RouteContext<Principal>): void {
    const asset = route === ROUTES.channelDocument || route === ROUTES.makeExternalDocument
      ? assets?.channelDocument
      : assets?.get(route.path);
    if (!asset) {
      fail(response, failure(404, 'not_found'));
      return;
    }
    sendBytes(response, 200, asset.contentType, asset.body);
  }

  const server = await startLoopbackServer<Principal>({
    ...(options.startPort === undefined ? {} : { startPort: options.startPort }),
    limits,
    routes,
    ...(options.log ? { log: options.log } : {}),
    authenticate: ({ request, route, params }) => authenticate(request, route, params),
    async handle(context) {
      try {
        switch (context.route) {
          case ROUTES.bootstrapDocument:
            sendBytes(context.response, 200, 'text/html; charset=utf-8', BOOTSTRAP_DOCUMENT);
            return;
          case ROUTES.bootstrapScript:
            sendBytes(context.response, 200, 'text/javascript; charset=utf-8', BOOTSTRAP_SCRIPT);
            return;
          case ROUTES.exchange: return await exchange(context);
          case ROUTES.session: return session(context);
          case ROUTES.create: return await create(context);
          case ROUTES.channel: return channel(context);
          case ROUTES.timeline: return timeline(context);
          case ROUTES.send: return await send(context);
          case ROUTES.hints: return hints(context);
          case ROUTES.binding: return binding(context);
          case ROUTES.releases: return releases(context);
          default:
            if (discovery && discoveryRole(context.route) !== null) return await discovery.handle(context);
            if (makeExternal && isMakeExternalRoute(context.route)) return await makeExternal.handle(context);
            return staticAsset(context);
        }
      } catch (error) {
        if (error instanceof BodyError) throw error;
        // Store exceptions after a write started are indeterminate, never success.
        const write = context.route.method === 'POST';
        fail(context.response, write ? failure(503, 'outcome_unknown') : failure(503, 'unavailable'));
      }
    },
  });

  origin = server.origin;
  return {
    port: server.port,
    origin: server.origin,
    async close() {
      authority.clear();
      await server.close();
    },
  };
}
