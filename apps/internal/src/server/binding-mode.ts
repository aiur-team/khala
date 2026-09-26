import type { ServerResponse } from 'node:http';
import {
  type AgentBindingAuthority, type AuthorizationId, type CommandId, type HarnessCapabilities, LISTENING_MODES, type ListeningMode,
  type ListeningModeCommand, type ListeningModeResult, type ListeningModeView, type OwnerAuthority, type OwnerRouteGrantCommand,
  type SessionBinding, decodeOwnerRouteGrantCommand,
} from '@khala/contracts/delivery/index';
import type { BindingPauseStore } from '../store/pause-store';
import type { Principal } from './credentials';
import { type ErrorCode, readJsonObject, sendError, sendJson } from './http';
import type { RouteContext, RouteSpec } from './server';

// Listening-mode control and pause for bound agents. The owner reads and sets the
// mode of, and pauses or resumes, one binding of a channel it holds; a bound agent
// reads and sets only its own binding's mode, never another binding's, and never
// pause or an experimental-route grant. Every change goes through the shared policy service over the SQLite
// listening-mode store, so owner and agent writes share one version and one
// idempotency journal. The view answered here is projected through the harness
// claims this server knows; an agent client re-projects it through its own harness.
// The server cannot inspect an agent's harness itself, so the agent's CLI reports what
// it observed (version and hook trust) and composition derives the released claim
// from that observation; the report selects no route and grants nothing.

export const OWNER_MODE_ROUTES = {
  list: { method: 'GET', path: '/api/v1/channels/:channelId/bindings', admission: 'authenticated' },
  get: { method: 'GET', path: '/api/v1/channels/:channelId/bindings/:bindingId/listening-mode', admission: 'authenticated' },
  set: { method: 'POST', path: '/api/v1/channels/:channelId/bindings/:bindingId/listening-mode', admission: 'authenticated' },
  pause: { method: 'POST', path: '/api/v1/channels/:channelId/bindings/:bindingId/pause', admission: 'authenticated' },
  grant: { method: 'POST', path: '/api/v1/channels/:channelId/bindings/:bindingId/experimental-route/grant', admission: 'authenticated' },
  revoke: { method: 'POST', path: '/api/v1/channels/:channelId/bindings/:bindingId/experimental-route/revoke', admission: 'authenticated' },
} as const satisfies Record<string, RouteSpec>;

export const AGENT_MODE_ROUTES = {
  get: { method: 'GET', path: '/api/v1/agent/listening-mode', admission: 'authenticated' },
  set: { method: 'POST', path: '/api/v1/agent/listening-mode', admission: 'authenticated' },
  harness: { method: 'POST', path: '/api/v1/agent/harness', admission: 'authenticated' },
} as const satisfies Record<string, RouteSpec>;

const OWNER_ROUTES: readonly RouteSpec[] = Object.values(OWNER_MODE_ROUTES);
const AGENT_ROUTES: readonly RouteSpec[] = Object.values(AGENT_MODE_ROUTES);
export const BINDING_MODE_ROUTES: readonly RouteSpec[] = [...OWNER_ROUTES, ...AGENT_ROUTES];

export function bindingModeRole(route: RouteSpec): 'human' | 'binding' | null {
  if (OWNER_ROUTES.includes(route)) return 'human';
  if (AGENT_ROUTES.includes(route)) return 'binding';
  return null;
}

type ModeContext = Readonly<{ binding: SessionBinding; status: 'active' | 'revoked' }>;

type RouteGrantResult =
  | Readonly<{ outcome: 'applied' | 'conflict'; view: ListeningModeView; reason: string | null }>
  | Readonly<{ outcome: 'refused'; reason: string }>;

/** The shared listening-mode service's read, set and owner experimental-route grants, as composition supplies them. */
export type BindingModeService = Readonly<{
  read(authority: OwnerAuthority | AgentBindingAuthority, context: ModeContext, capabilities: HarnessCapabilities | null): Promise<
    Readonly<{ ok: true; view: ListeningModeView }> | Readonly<{ ok: false; code: string }>
  >;
  set(
    authority: OwnerAuthority | AgentBindingAuthority, context: ModeContext, capabilities: HarnessCapabilities | null,
    command: ListeningModeCommand,
  ): Promise<ListeningModeResult>;
  grantExperimentalRoute(
    authority: OwnerAuthority, context: ModeContext, capabilities: HarnessCapabilities | null, command: OwnerRouteGrantCommand,
  ): Promise<RouteGrantResult>;
  revokeExperimentalRoute(
    authority: OwnerAuthority, context: ModeContext, capabilities: HarnessCapabilities | null, command: OwnerRouteGrantCommand,
  ): Promise<RouteGrantResult>;
}>;

export const HOOK_REVIEW_STATES = ['trusted', 'awaiting_hook_review', 'unknown'] as const;

/** What a bound agent's CLI observed about its own harness; evidence input, never authority. */
export type HarnessObservation = Readonly<{
  version: string;
  hookReview: (typeof HOOK_REVIEW_STATES)[number];
}>;

/** Composition-supplied parts of binding mode control. */
export type BindingModeOptions = Readonly<{
  modes: BindingModeService;
  pause: BindingPauseStore;
  /** The released harness claim for the binding; null when nothing about its harness is known. */
  capabilities(binding: SessionBinding): HarnessCapabilities | null;
  /** Records the agent's latest observation of its own harness for that binding generation. */
  observe(binding: SessionBinding, observation: HarnessObservation): void;
}>;

export type OwnerBindings =
  | Readonly<{ kind: 'bindings'; bindings: readonly Readonly<{ binding: SessionBinding; displayName: string }>[] }>
  | Readonly<{ kind: 'not_found' | 'not_joined' | 'unavailable' }>;

export type OwnerTarget =
  | Readonly<{ kind: 'binding'; binding: SessionBinding; status: 'active' }>
  | Readonly<{ kind: 'not_found' | 'not_joined' | 'unavailable' }>;

export type BindingModeDeps = Readonly<{
  options: BindingModeOptions;
  maxBodyBytes: number;
  clock: () => number;
  /** The newest generation of `bindingId` among the channel's bindings, for a human who holds the channel. */
  ownerTarget(channelId: string, bindingId: string, principal: Principal): OwnerTarget;
  /** Every live binding of the channel, for a human who holds the channel. */
  ownerBindings(channelId: string, principal: Principal): OwnerBindings;
  /** Runs an agent write at the commit point: authority rechecked, through the revocation barrier. `null` means already answered. */
  commitAgent<T>(context: RouteContext<Principal>, effect: () => T): T | null;
}>;

const COMMAND_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const ISSUED_AT_BYTES = 64;
const HARNESS_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function fail(response: ServerResponse, status: number, code: ErrorCode): void {
  sendError(response, status, code);
}

function mode(value: unknown): value is ListeningMode {
  return typeof value === 'string' && (LISTENING_MODES as readonly string[]).includes(value);
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Audit data only, never authority; bounded because it is part of the command fingerprint. */
function issuedAt(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= ISSUED_AT_BYTES && !/[\p{Cc}]/u.test(value);
}

function commandId(value: unknown): value is CommandId {
  return typeof value === 'string' && COMMAND_ID.test(value);
}

function ownerAuthority(principal: Extract<Principal, { kind: 'human' }>, now: number): OwnerAuthority {
  return {
    ownerId: principal.human.ownerId,
    issuer: 'khala-internal',
    subject: principal.human.participantId,
    authenticatedAt: new Date(now).toISOString(),
    authorizationId: principal.sessionKey as AuthorizationId,
  };
}

function publicBinding(binding: SessionBinding) {
  const { v, bindingId, ownerId, agentParticipantId, deviceId, harness, sessionId, generation } = binding;
  return { v, bindingId, ownerId, agentParticipantId, deviceId, harness, sessionId, generation };
}

function targetFailure(response: ServerResponse, kind: 'not_found' | 'not_joined' | 'unavailable'): void {
  if (kind === 'not_found') fail(response, 404, 'not_found');
  else if (kind === 'not_joined') fail(response, 403, 'not_joined');
  else fail(response, 503, 'unavailable');
}

function modeReadFailure(response: ServerResponse, code: string): void {
  if (code === 'binding_revoked' || code === 'stale_binding' || code === 'binding_mismatch') fail(response, 401, 'unauthenticated');
  else if (code === 'forbidden') fail(response, 403, 'forbidden');
  else fail(response, 503, 'unavailable');
}

async function ownerRoute(context: RouteContext<Principal>, deps: BindingModeDeps): Promise<void> {
  const { principal, params, response, route } = context;
  if (principal?.kind !== 'human') {
    fail(response, 403, 'forbidden');
    return;
  }
  const authority = ownerAuthority(principal, deps.clock());
  if (route === OWNER_MODE_ROUTES.list) {
    const listed = deps.ownerBindings(params.channelId!, principal);
    if (listed.kind !== 'bindings') {
      targetFailure(response, listed.kind);
      return;
    }
    const bindings = [];
    for (const { binding, displayName } of listed.bindings) {
      const capabilities = deps.options.capabilities(binding);
      const read = await deps.options.modes.read(authority, { binding, status: 'active' }, capabilities);
      const paused = deps.options.pause.read(binding);
      // One unreadable binding fails the whole list: the owner never sees a partial view as complete.
      if (!read.ok || paused === 'unavailable') {
        fail(response, 503, 'unavailable');
        return;
      }
      // Decisions 34 and 37: an idle agent is reached before its next turn only on a proven wake route.
      const idle = capabilities?.immediateNotification;
      const idleDelivery = idle === undefined || idle === 'unknown' || idle === 'unsupported' ? 'unproven' : 'proven';
      // The version and ownership let the panel label who made the last change as the hosted panel does.
      bindings.push({
        binding: publicBinding(binding), displayName, harnessVersion: capabilities?.version ?? null,
        ownedByViewer: binding.ownerId === authority.ownerId, view: read.view, paused, idleDelivery,
      });
    }
    sendJson(response, 200, { v: 1, bindings });
    return;
  }
  const body = route.method === 'POST' ? await readJsonObject(context, deps.maxBodyBytes) : null;
  const target = deps.ownerTarget(params.channelId!, params.bindingId!, principal);
  if (target.kind !== 'binding') {
    targetFailure(response, target.kind);
    return;
  }
  const { binding, status } = target;
  const capabilities = deps.options.capabilities(binding);
  const identity = { bindingId: binding.bindingId, generation: binding.generation };

  if (route === OWNER_MODE_ROUTES.get) {
    const read = await deps.options.modes.read(authority, { binding, status }, capabilities);
    if (!read.ok) {
      modeReadFailure(response, read.code);
      return;
    }
    const paused = deps.options.pause.read(binding);
    if (paused === 'unavailable') {
      fail(response, 503, 'unavailable');
      return;
    }
    sendJson(response, 200, { v: 1, view: read.view, paused });
    return;
  }

  if (route === OWNER_MODE_ROUTES.set) {
    // `issuedAt` comes from the client so a retry of the same command keeps its fingerprint and replays.
    if (!exactKeys(body!, ['v', 'commandId', 'generation', 'expectedVersion', 'requested', 'issuedAt']) || body!.v !== 1
      || !commandId(body!.commandId) || !count(body!.generation) || !count(body!.expectedVersion) || !mode(body!.requested)
      || !issuedAt(body!.issuedAt)) {
      fail(response, 400, 'invalid_request');
      return;
    }
    const command: ListeningModeCommand = {
      v: 1,
      commandId: body!.commandId,
      bindingId: binding.bindingId,
      expectedBindingGeneration: body!.generation,
      expectedVersion: body!.expectedVersion,
      requested: body!.requested,
      issuedAt: body!.issuedAt,
    };
    sendJson(response, 200, await deps.options.modes.set(authority, { binding, status }, capabilities, command));
    return;
  }

  if (route === OWNER_MODE_ROUTES.grant || route === OWNER_MODE_ROUTES.revoke) {
    // The owner names the exact route, tested version and evidence revision they reviewed; the service
    // refuses a grant whose pin no longer matches the binding's current experimental claim.
    if (!exactKeys(body!, ['v', 'commandId', 'generation', 'expectedVersion', 'mode', 'route', 'harnessVersion', 'evidenceRevision', 'issuedAt'])
      || body!.v !== 1 || !commandId(body!.commandId) || !count(body!.generation) || !count(body!.expectedVersion)
      || !mode(body!.mode) || !issuedAt(body!.issuedAt)) {
      fail(response, 400, 'invalid_request');
      return;
    }
    const grant = route === OWNER_MODE_ROUTES.grant;
    const decoded = decodeOwnerRouteGrantCommand({
      v: 1, kind: grant ? 'grant_experimental_route' : 'revoke_experimental_route', commandId: body!.commandId,
      bindingId: binding.bindingId, expectedBindingGeneration: body!.generation, expectedVersion: body!.expectedVersion,
      mode: body!.mode, route: body!.route, harnessVersion: body!.harnessVersion, evidenceRevision: body!.evidenceRevision,
      issuedAt: body!.issuedAt,
    });
    if (!decoded.ok) {
      fail(response, 400, 'invalid_request');
      return;
    }
    const modes = deps.options.modes;
    const result = grant
      ? await modes.grantExperimentalRoute(authority, { binding, status }, capabilities, decoded.value)
      : await modes.revokeExperimentalRoute(authority, { binding, status }, capabilities, decoded.value);
    sendJson(response, 200, { v: 1, commandId: decoded.value.commandId, ...identity, ...result });
    return;
  }

  // Pause and resume name the exact generation the owner saw; a newer one is not paused by an older view.
  if (!exactKeys(body!, ['v', 'generation', 'paused']) || body!.v !== 1 || !count(body!.generation)
    || typeof body!.paused !== 'boolean') {
    fail(response, 400, 'invalid_request');
    return;
  }
  if (body!.generation !== binding.generation) {
    fail(response, 409, 'operation_mismatch');
    return;
  }
  const written = deps.options.pause.set(binding, body!.paused);
  if (written.kind !== 'done') {
    fail(response, 503, 'outcome_unknown');
    return;
  }
  sendJson(response, 200, { v: 1, ...identity, paused: written.paused });
}

async function agentRoute(context: RouteContext<Principal>, deps: BindingModeDeps): Promise<void> {
  const { principal, response, route } = context;
  if (principal?.kind !== 'binding') {
    fail(response, 403, 'forbidden');
    return;
  }
  const binding = principal.binding;
  // Agent authority is the held capability's own binding generation, never a request field.
  const authority = { kind: 'agent_binding', bindingId: binding.bindingId, generation: binding.generation } as AgentBindingAuthority;
  const capabilities = deps.options.capabilities(binding);

  if (route === AGENT_MODE_ROUTES.get) {
    const read = await deps.options.modes.read(authority, { binding, status: 'active' }, capabilities);
    if (!read.ok) {
      modeReadFailure(response, read.code);
      return;
    }
    // The binding travels with the view so the client projects it through that binding's own harness.
    sendJson(response, 200, { v: 1, binding: publicBinding(binding), view: read.view });
    return;
  }

  const body = await readJsonObject(context, deps.maxBodyBytes);
  if (route === AGENT_MODE_ROUTES.harness) {
    if (!exactKeys(body, ['v', 'version', 'hookReview']) || body.v !== 1
      || typeof body.version !== 'string' || !HARNESS_VERSION.test(body.version)
      || !(HOOK_REVIEW_STATES as readonly unknown[]).includes(body.hookReview)) {
      fail(response, 400, 'invalid_request');
      return;
    }
    const observation = { version: body.version, hookReview: body.hookReview as HarnessObservation['hookReview'] };
    if (deps.commitAgent(context, () => deps.options.observe(binding, observation)) === null) return;
    sendJson(response, 200, { v: 1 });
    return;
  }
  if (!exactKeys(body, ['v', 'commandId', 'expectedVersion', 'requested', 'issuedAt']) || body.v !== 1
    || !commandId(body.commandId) || !count(body.expectedVersion) || !mode(body.requested) || !issuedAt(body.issuedAt)) {
    fail(response, 400, 'invalid_request');
    return;
  }
  const command: ListeningModeCommand = {
    v: 1,
    commandId: body.commandId,
    bindingId: binding.bindingId,
    expectedBindingGeneration: binding.generation,
    expectedVersion: body.expectedVersion,
    requested: body.requested,
    issuedAt: body.issuedAt,
  };
  // Committed through the revocation barrier: Stop drains this write before it reports the binding stopped.
  const pending = deps.commitAgent(context, () => deps.options.modes.set(authority, { binding, status: 'active' }, capabilities, command));
  if (pending === null) return;
  sendJson(response, 200, await pending);
}

export async function handleBindingMode(context: RouteContext<Principal>, deps: BindingModeDeps): Promise<void> {
  return bindingModeRole(context.route) === 'human' ? ownerRoute(context, deps) : agentRoute(context, deps);
}
