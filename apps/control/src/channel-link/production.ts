import type { RouteRegistration } from '../runtime/handler';
import { createProductionHumanRuntimeLoader, createProductionHumanServiceLoader, type ProductionHumanDependencies } from '../composition/human/production';
import { createChannelLinkHandlers, HUMAN_CHANNEL_LINK_PERSONAL_PATH, HUMAN_CHANNEL_LINK_RESOLVE_PATH } from './handler';

/** Human routes are request-scoped; the agent route awaits the trusted #518 native auth composition. */
export function createHostedHumanChannelLinkRoutes(options: ProductionHumanDependencies): readonly RouteRegistration[] {
  const runtime = createProductionHumanRuntimeLoader(options);
  const loadServices = createProductionHumanServiceLoader(options);
  const route = (path: string): RouteRegistration => ({
    path, methods: ['POST'],
    async handle(request) {
      try {
        const active = runtime();
        const services = await loadServices(request);
        if (!services) throw new Error('human runtime unavailable');
        const handlers = createChannelLinkHandlers({
          origin: active.env.publicAppOrigin, store: active.store,
          secret: active.env.invitationHmacSecret, clock: active.clock,
          auth: active.auth, admissionFor: () => services.admission,
        });
        return handlers.human.find(item => item.path === path)!.handle(request);
      } catch {
        return new Response(JSON.stringify({ v: 1, kind: 'unavailable' }), { status: 503, headers: {
          'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        } });
      }
    },
  });
  return Object.freeze([route(HUMAN_CHANNEL_LINK_RESOLVE_PATH), route(HUMAN_CHANNEL_LINK_PERSONAL_PATH)]);
}
