import { getStore } from '@netlify/blobs';
import { createProductionHumanServiceLoader } from '../composition/human/production';
import { createControlStore, type BlobsStoreLike } from '../runtime/control-store';
import { readHumanServerEnv } from '../runtime/env';
import type { RouteRegistration } from '../runtime/handler';
import { createChannelClosureHandlers } from './handler';
import { createMatrixClosureTransport } from './matrix';
import { createChannelClosureService } from './service';

/**
 * Additive human route producer. It uses the same OIDC service loader as the
 * hosted human flow and the same durable control-state namespaces. No agent
 * registration, browser credential, or Matrix message can invoke this route.
 */
export function registerClosureHandlers(): readonly RouteRegistration[] {
  const loadHuman = createProductionHumanServiceLoader();
  let store: ReturnType<typeof createControlStore> | null = null;
  let homeserverOrigin: string | null = null;

  return [{
    path: '/api/human/channel-closure',
    methods: ['GET', 'POST'],
    async handle(request) {
      const human = await loadHuman(request);
      if (human === null || !human.messaging) return new Response(JSON.stringify({ code: 'feature_unavailable' }), { status: 503 });
      if (!store || !homeserverOrigin) {
        const env = readHumanServerEnv();
        const storeFor = (name: string) => getStore(name) as unknown as BlobsStoreLike;
        store = createControlStore({
          records: storeFor(`${env.controlStateNamespace}-records`),
          operations: storeFor(`${env.controlStateNamespace}-operations`),
          clock: () => Date.now(),
        });
        homeserverOrigin = env.publicHomeserverOrigin;
      }
      const activeStore = store;
      const activeOrigin = homeserverOrigin;
      const handlers = createChannelClosureHandlers({
        auth: human.auth,
        service: principal => createChannelClosureService({
          principal,
          store: activeStore,
          transport: createMatrixClosureTransport({
            principal, sessions: human.messaging!, homeserverOrigin: activeOrigin,
          }),
        }),
      });
      return handlers[0]!.handle(request);
    },
  }];
}
