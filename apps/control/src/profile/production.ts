import { randomBytes } from 'node:crypto';
import { PROFILE_PATH, PROFILE_USERNAME_PATH } from '@khala/contracts/m1/profile';
import type { ProductionHumanRuntime } from '../composition/human/production';
import type { RouteRegistration } from '../runtime/handler';
import { createProfileHandlers } from './routes';
import { createProductionAgentProvisioner } from '../agent-join/production-provisioner';
import { renameDefaultAgents } from '../agent-join/rename';

/** Route discovery is pure; adapters are bound on each request. */
export function createProfileRoutes(loadRuntime: () => ProductionHumanRuntime, fetch?: typeof globalThis.fetch): readonly RouteRegistration[] {
  function handlers() {
    const active = loadRuntime();
    return createProfileHandlers({ auth: active.auth, store: active.store, clock: active.clock, random: randomBytes,
      setDisplayName: active.matrix.setOwnerDisplayName,
      afterUsernameChange: (ownerId, previous, next) => renameDefaultAgents({ store: active.store, clock: active.clock,
        provisioner: createProductionAgentProvisioner(active, fetch) }, ownerId, previous, next) });
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
    route(PROFILE_PATH, 'GET', active => active.get),
    route(PROFILE_USERNAME_PATH, 'POST', active => active.setUsername),
  ]);
}
