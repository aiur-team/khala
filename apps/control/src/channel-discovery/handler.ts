// Authenticated discovery routes. The agent listing route accepts only a live
// RD2A discovery credential; human routes accept only an authenticated owner
// mutation; the rollout route also requires operator authority. Every response
// is JSON, `no-store`, and never a redirect. Nothing here logs, and telemetry
// carries only digests, result codes and counts: titles, references, cursors
// and room IDs never reach it.

import {
  type ControlStore,
  type RoomId,
  type StableAgentPrincipal,
  type TrustedClock,
  MAX_CHANNEL_LIST_PAGE_SIZE,
  decodeChannelListQuery,
  decodeRoomId,
} from '@khala/contracts/messaging/index';
import type { MutationAuthorization } from '../auth/index';
import type { Random } from '../auth/store';
import type { RouteRegistration } from '../runtime/handler';
import type { DiscoveryCredentials } from './bootstrap/handler';
import {
  type ChannelOwnerAuthority,
  type KnownPrincipalDirectory,
  createPrivateEligibility,
  normalizeTitle,
  setVisibility,
} from './catalog';
import type { CrawlDetector } from './crawl';
import { type ListingCaller, type ListingResolution, listChannels, resolveListingRef } from './listing';
import {
  type OperatorAuthority,
  type PublicDiscoverySource,
  type RolloutAction,
  applyRollout,
  decodeDrillReport,
  resolveGates,
} from './rollout';
import { type DiscoveryTelemetrySink, type ListOutcome, accountDigest, emit, sessionDigest, telemetryDigest } from './telemetry';

export const LIST_PATH = '/api/agent/channels';
export const SETTINGS_PATH = '/api/human/channel-discovery/settings';
export const ALLOWLIST_PATH = '/api/human/channel-discovery/allowlist';
export const ROLLOUT_PATH = '/api/human/channel-discovery/rollout';

export type ChannelDiscoveryDeps = Readonly<{
  store: ControlStore;
  clock: TrustedClock;
  random: Random;
  credentials: DiscoveryCredentials;
  /** Origin, fetch-metadata, session and CSRF guard for owner mutations. */
  authorizeMutation(request: Request): Promise<MutationAuthorization>;
  ownerAuthority: ChannelOwnerAuthority;
  principals: KnownPrincipalDirectory;
  /**
   * A static value, or the hosted rollout record read on every request. Hosted
   * public discovery stays disabled until an operator enables it after a drill.
   */
  publicDiscovery: PublicDiscoverySource;
  /** Hosted rollout controls. Without them the rollout route answers `feature_unavailable`. */
  operators?: OperatorAuthority;
  telemetry?: DiscoveryTelemetrySink;
  crawl?: CrawlDetector;
}>;

export type ChannelDiscoveryHandlers = Readonly<{
  agent: readonly RouteRegistration[];
  human: readonly RouteRegistration[];
  /** Server-side listing-reference resolution for the access-request journal. */
  resolveListingRef(caller: ListingCaller, listingRef: string): Promise<ListingResolution>;
}>;

const HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } as const;
const REVISION = /^[1-9][0-9]{0,15}$/;
const OPERATION = /^[A-Za-z0-9._:-]{1,128}$/;
const ROLLOUT_ACTIONS: readonly RolloutAction[] = ['enable', 'disable', 'engage_kill_switch', 'release_kill_switch', 'record_drill'];

export function createChannelDiscoveryHandlers(deps: ChannelDiscoveryDeps): ChannelDiscoveryHandlers {
  // Every request re-reads the rollout record: the kill switch applies to the next request.
  const catalogFor = async () => ({
    store: deps.store, clock: deps.clock, ownerAuthority: deps.ownerAuthority, principals: deps.principals,
    publicDiscovery: (await resolveGates(deps.publicDiscovery)).settings,
  });
  const listingFor = (publicDiscovery: 'enabled' | 'disabled') => ({
    store: deps.store, clock: deps.clock, random: deps.random, ownerAuthority: deps.ownerAuthority, publicDiscovery,
  });

  async function list(request: Request): Promise<Response> {
    const query = readListQuery(new URL(request.url).searchParams);
    if (!query) return error(400, 'invalid_request');
    let authorization;
    try {
      authorization = await deps.credentials.authorize(request, 'list_channels');
    } catch {
      return error(503, 'feature_unavailable');
    }
    if (authorization.kind === 'unavailable') return error(503, 'feature_unavailable');
    if (authorization.kind === 'refused') return error(authorization.status, authorization.code);
    const gates = await resolveGates(deps.publicDiscovery);
    const caller = { ownerId: authorization.ownerId, requester: authorization.requester };
    const result = await listChannels(listingFor(gates.listing), caller, query);
    const outcome: ListOutcome = result.kind === 'ok' ? 'ok' : result.kind === 'rejected' ? result.code : 'unavailable';
    const items = result.kind === 'ok' ? result.value.items : [];
    const publicItems = items.filter(item => item.visibility === 'public').length;
    await emit(deps.telemetry, {
      v: 1, event: 'channel_discovery.list', at: new Date(deps.clock()).toISOString(),
      account: accountDigest(caller.ownerId),
      session: sessionDigest(caller.ownerId, caller.requester.principal, caller.requester.sessionGeneration),
      page: query.cursor === null ? 'first' : 'next', result: outcome, items: items.length, publicItems, publicDiscovery: gates.label,
    });
    try {
      await deps.crawl?.observe({ ownerId: caller.ownerId, result: outcome, publicItems });
    } catch {
      // Detection is best effort; the hard limits in `listing.ts` still hold.
    }
    if (result.kind === 'ok') return body(200, result.value);
    if (result.kind === 'rejected') return error(result.code === 'rate_limited' ? 429 : 410, result.code);
    return error(503, 'feature_unavailable');
  }

  async function settings(request: Request): Promise<Response> {
    const owner = await mutationOwner(request);
    if (owner instanceof Response) return owner;
    const input = await readJson(request, ['v', 'operationId', 'roomId', 'visibility', 'title', 'expectedRevision']);
    const roomId = input && readRoom(input.roomId);
    if (!input || !roomId || input.v !== 1 || !isOperation(input.operationId) || (input.expectedRevision !== null && !isRevision(input.expectedRevision))
      || (input.visibility !== 'public' && input.visibility !== 'private' && input.visibility !== 'secret')) return rejection(400, 'invalid_request');
    const title = input.visibility === 'secret' ? (input.title === null ? null : undefined) : normalizeTitle(input.title) ?? undefined;
    if (title === undefined) return rejection(400, 'invalid_request');
    return mutationResponse(await setVisibility(await catalogFor(), {
      v: 1, operationId: input.operationId, roomId, visibility: input.visibility, title, expectedRevision: input.expectedRevision,
    }, owner));
  }

  async function allowlist(request: Request): Promise<Response> {
    const owner = await mutationOwner(request);
    if (owner instanceof Response) return owner;
    const input = await readJson(request, ['v', 'action', 'operationId', 'roomId', 'principal', 'expectedSessionGeneration', 'expectedRevision']);
    const roomId = input && readRoom(input.roomId);
    if (!input || !roomId || input.v !== 1 || (input.action !== 'allow' && input.action !== 'revoke') || !isOperation(input.operationId)
      || typeof input.principal !== 'string' || !OPERATION.test(input.principal)
      || !Number.isSafeInteger(input.expectedSessionGeneration) || (input.expectedSessionGeneration as number) < 0
      || !isRevision(input.expectedRevision)) return rejection(400, 'invalid_request');
    const mutation = {
      v: 1 as const, operationId: input.operationId, roomId, principal: input.principal as StableAgentPrincipal,
      expectedSessionGeneration: input.expectedSessionGeneration as number, expectedRevision: input.expectedRevision,
    };
    const eligibility = createPrivateEligibility(await catalogFor());
    return mutationResponse(input.action === 'allow'
      ? await eligibility.allowRoom(mutation, owner)
      : await eligibility.revokeRoom(mutation, owner));
  }

  async function rollout(request: Request): Promise<Response> {
    if (!deps.operators) return rejection(503, 'feature_unavailable');
    const operator = await mutationOwner(request);
    if (operator instanceof Response) return operator;
    const input = await readJson(request, ['v', 'action', 'operationId', 'expectedRevision', 'drill']);
    const action = input?.action;
    if (!input || input.v !== 1 || !isOperation(input.operationId) || (input.expectedRevision !== null && typeof input.expectedRevision !== 'string')
      || !ROLLOUT_ACTIONS.includes(action as RolloutAction)) return rejection(400, 'invalid_request');
    const drill = input.drill === null ? null : decodeDrillReport(input.drill);
    if (input.drill !== null && drill === null) return rejection(400, 'invalid_request');
    const result = await applyRollout({ store: deps.store, clock: deps.clock, operators: deps.operators }, {
      v: 1, action: action as RolloutAction, operationId: input.operationId, expectedRevision: input.expectedRevision, drill,
    }, operator);
    await emit(deps.telemetry, {
      v: 1, event: 'channel_discovery.rollout', at: new Date(deps.clock()).toISOString(),
      operator: telemetryDigest('operator', operator.ownerId), action: action as RolloutAction,
      result: result.kind === 'ok' ? 'applied' : result.kind === 'rejected' ? result.code : 'unavailable',
    });
    if (result.kind === 'ok') return body(200, { v: 1, kind: 'applied', revision: result.value.revision });
    if (result.kind === 'rejected') {
      return rejection(result.code === 'forbidden' ? 403 : result.code === 'drill_failed' ? 400 : 409, result.code);
    }
    return rejection(503, 'feature_unavailable');
  }

  async function mutationOwner(request: Request) {
    let authorization: MutationAuthorization;
    try {
      authorization = await deps.authorizeMutation(request);
    } catch {
      return rejection(503, 'feature_unavailable');
    }
    if (authorization.kind === 'unavailable') return rejection(503, 'feature_unavailable');
    if (authorization.kind === 'rejected') return rejection(authorization.code === 'signed_out' ? 401 : 403, authorization.code);
    return authorization.context.principal;
  }

  return {
    agent: [Object.freeze({ path: LIST_PATH, methods: Object.freeze(['GET']), handle: list })],
    human: [
      Object.freeze({ path: SETTINGS_PATH, methods: Object.freeze(['PUT']), handle: settings }),
      Object.freeze({ path: ALLOWLIST_PATH, methods: Object.freeze(['POST']), handle: allowlist }),
      Object.freeze({ path: ROLLOUT_PATH, methods: Object.freeze(['PUT']), handle: rollout }),
    ],
    resolveListingRef: async (caller, listingRef) =>
      resolveListingRef(listingFor((await resolveGates(deps.publicDiscovery)).listing), caller, listingRef),
  };
}

function readListQuery(params: URLSearchParams) {
  if ([...params.keys()].some(name => name !== 'cursor' && name !== 'limit')) return null;
  const cursors = params.getAll('cursor');
  const limits = params.getAll('limit');
  if (cursors.length > 1 || limits.length > 1) return null;
  if (limits.length === 1 && !/^[1-9][0-9]?$/.test(limits[0]!)) return null;
  const decoded = decodeChannelListQuery({
    v: 1, cursor: cursors[0] ?? null, limit: limits.length === 1 ? Number(limits[0]) : MAX_CHANNEL_LIST_PAGE_SIZE,
  });
  return decoded.ok ? decoded.value : null;
}

async function readJson<const K extends string>(request: Request, keys: readonly K[]): Promise<Record<K, unknown> | null> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return null;
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const present = Object.keys(value);
  return present.length === keys.length && keys.every(key => Object.hasOwn(value, key)) ? value as Record<K, unknown> : null;
}

function readRoom(value: unknown): RoomId | null {
  const decoded = decodeRoomId(value);
  return decoded.ok ? decoded.value : null;
}

function isOperation(value: unknown): value is string {
  return typeof value === 'string' && OPERATION.test(value);
}

function isRevision(value: unknown): value is string {
  return typeof value === 'string' && REVISION.test(value);
}

function mutationResponse(result: Awaited<ReturnType<typeof setVisibility>>): Response {
  if (result.kind === 'ok') return body(200, { v: 1, kind: 'applied', revision: result.value.revision });
  if (result.kind === 'rejected') return rejection(result.code === 'invalid_title' ? 400 : result.code === 'forbidden' || result.code === 'public_discovery_disabled' ? 403 : 409, result.code);
  return rejection(503, 'feature_unavailable');
}

function body(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: HEADERS });
}

function error(status: number, code: string): Response {
  return body(status, { error: code });
}

function rejection(status: number, code: string): Response {
  return body(status, { v: 1, kind: 'rejected', code });
}
