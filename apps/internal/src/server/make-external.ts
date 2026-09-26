import type { OwnerId, ParticipantId } from '@khala/contracts/messaging/ids';
import {
  type MakeExternalAction, type MakeExternalJourneyView, type MakeExternalRejection, decodeMakeExternalAction,
} from '@khala/contracts/messaging/make-external';
import type { OperationResult } from '@khala/contracts/messaging/outcomes';
import type { Principal } from './credentials';
import { readJsonObject, sendError, sendJson } from './http';
import type { RouteContext, RouteSpec } from './server';

// Loopback routes of the Make-external journey. Both admit only the browser human
// (cookie plus request secret) and take the acting owner from that principal, never
// from JSON. A refused action still answers with the current view, so the browser
// never guesses what state its refusal left behind.

export type MakeExternalHuman = Readonly<{ ownerId: OwnerId; participantId: ParticipantId }>;

export type MakeExternalActResult =
  | Readonly<{ kind: 'ok'; view: MakeExternalJourneyView; rejection: MakeExternalRejection | null }>
  | Readonly<{ kind: 'rejected'; code: 'not_found' | 'forbidden' }>
  | Readonly<{ kind: 'unavailable' }>;

/** Implemented by the internal composition; the server only authenticates, decodes and maps results. */
export interface MakeExternalJourneyPort {
  view(human: MakeExternalHuman, channelId: string): Promise<OperationResult<MakeExternalJourneyView, 'not_found' | 'forbidden'>>;
  act(human: MakeExternalHuman, channelId: string, action: MakeExternalAction): Promise<MakeExternalActResult>;
}

export const MAKE_EXTERNAL_ROUTES = {
  view: { method: 'GET', path: '/api/v1/channels/:channelId/make-external', admission: 'authenticated' },
  act: { method: 'POST', path: '/api/v1/channels/:channelId/make-external', admission: 'authenticated' },
} as const satisfies Record<string, RouteSpec>;

const ROUTES: ReadonlySet<RouteSpec> = new Set(Object.values(MAKE_EXTERNAL_ROUTES));

/** True for the routes this module owns; each admits the human principal only. */
export function isMakeExternalRoute(route: RouteSpec): boolean {
  return ROUTES.has(route);
}

export type MakeExternalRoutes = Readonly<{
  routes: readonly RouteSpec[];
  handle(context: RouteContext<Principal>): Promise<void>;
}>;

export function createMakeExternalRoutes(deps: Readonly<{ journey: MakeExternalJourneyPort; maxBodyBytes: number }>): MakeExternalRoutes {
  function humanOf(context: RouteContext<Principal>): MakeExternalHuman {
    const principal = context.principal;
    if (principal?.kind !== 'human') throw new Error('make-external route reached without a human principal');
    return { ownerId: principal.human.ownerId, participantId: principal.human.participantId };
  }

  async function view(context: RouteContext<Principal>): Promise<void> {
    const result = await deps.journey.view(humanOf(context), context.params.channelId!);
    if (result.kind === 'ok') sendJson(context.response, 200, result.value);
    else if (result.kind === 'rejected') sendError(context.response, result.code === 'not_found' ? 404 : 403, result.code);
    else sendError(context.response, 503, 'unavailable');
  }

  async function act(context: RouteContext<Principal>): Promise<void> {
    const decoded = decodeMakeExternalAction(await readJsonObject(context, deps.maxBodyBytes));
    if (!decoded.ok) {
      sendError(context.response, 400, 'invalid_request');
      return;
    }
    const result = await deps.journey.act(humanOf(context), context.params.channelId!, decoded.value);
    if (result.kind === 'ok') sendJson(context.response, 200, { v: 1, view: result.view, rejection: result.rejection });
    else if (result.kind === 'rejected') sendError(context.response, result.code === 'not_found' ? 404 : 403, result.code);
    // The action may or may not have taken effect; the browser retries it with the same operation ID.
    else sendError(context.response, 503, 'outcome_unknown');
  }

  return {
    routes: Object.values(MAKE_EXTERNAL_ROUTES),
    async handle(context) {
      if (context.route === MAKE_EXTERNAL_ROUTES.view) return view(context);
      return act(context);
    },
  };
}
