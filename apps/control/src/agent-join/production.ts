import { AGENT_SESSION_RESUME_PATH, createAgentSessionResumeHandler, AGENT_SESSION_STATUS_PATH, createAgentSessionStatusHandler } from './session-status';
import { randomBytes } from 'node:crypto';
import type { ProductionHumanRuntime } from '../composition/human/production';
import type { RouteRegistration } from '../runtime/handler';
import { createJoinStore } from './store';
import { createProductionAgentProvisioner } from './production-provisioner';
import { createAgentRenameHandler, AGENT_RENAME_PATH } from './rename-routes';
import { createAgentJoinAgentHandlers, AGENT_JOIN_PATH, AGENT_JOIN_POLL_PATH, AGENT_JOIN_READY_PATH } from './agent-routes';
import { createAgentJoinHumanHandlers, AGENT_JOIN_HUMAN_VIEW_PATH, AGENT_JOIN_HUMAN_CONFIRM_PATH, AGENT_JOIN_HUMAN_STATUS_PATH } from './human-routes';

/** Bind request-scoped handlers lazily; discovery performs no adapter I/O. */
export function createAgentJoinRoutes(loadRuntime: () => ProductionHumanRuntime, fetch?: typeof globalThis.fetch): readonly RouteRegistration[] {
  function handlers() {
    const active = loadRuntime();
    const random = (bytes: number) => randomBytes(bytes);
    const joins = createJoinStore({ store: active.store, clock: active.clock, random });
    const agent = createAgentJoinAgentHandlers({ joins, store: active.store, clock: active.clock, random,
      origin: active.env.publicAppOrigin, secret: active.env.invitationHmacSecret, roomName: active.matrix.roomName });
    const provisioner = createProductionAgentProvisioner(active, fetch);
    const human = createAgentJoinHumanHandlers({ auth: active.auth, joins, store: active.store, clock: active.clock, random,
      sealSecret: active.env.invitationHmacSecret, inspectMembership: active.matrix.inspectOwnerMembership, revokeAgentSession: active.matrix.revokeAgentSession, provisioner,
      roomMemberNames: async (ownerId, roomId) => (await active.matrix.roomMembers(ownerId, roomId))?.map(member => member.name) ?? null });
    const rename = createAgentRenameHandler({ auth: active.auth, store: active.store, clock: active.clock, provisioner,
      roomMembers: active.matrix.roomMembers });
    return { agent, human, rename, sessionResume: createAgentSessionResumeHandler(active.store, { homeserverOrigin: active.env.publicHomeserverOrigin, provisioner, ...(fetch ? { fetch } : {}) }), sessionStatus: createAgentSessionStatusHandler(active.store, { homeserverOrigin: active.env.publicHomeserverOrigin, ...(fetch ? { fetch } : {}) }) };
  }
  function route(path: string, method: 'GET' | 'POST', select: (active: ReturnType<typeof handlers>) => (request: Request) => Promise<Response>): RouteRegistration {
    return { path, methods: [method], async handle(request) {
      try { return await select(handlers())(request); }
      catch { return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503, headers: {
        'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      } }); }
    } };
  }
  return Object.freeze([
    route(AGENT_SESSION_RESUME_PATH, 'POST', active => active.sessionResume),
    route(AGENT_SESSION_STATUS_PATH, 'GET', active => active.sessionStatus),
    route(AGENT_RENAME_PATH, 'POST', active => active.rename),
    route(AGENT_JOIN_PATH, 'POST', active => active.agent.create),
    route(AGENT_JOIN_POLL_PATH, 'GET', active => active.agent.poll),
    route(AGENT_JOIN_READY_PATH, 'POST', active => active.agent.ready),
    route(AGENT_JOIN_HUMAN_VIEW_PATH, 'GET', active => active.human.view),
    route(AGENT_JOIN_HUMAN_CONFIRM_PATH, 'POST', active => active.human.confirm),
    route(AGENT_JOIN_HUMAN_STATUS_PATH, 'GET', active => active.human.status),
  ]);
}
