import { getStore } from '@netlify/blobs';
import { decodeClosureConnectorReceipt, type AuthPrincipal, type ClosureConnectorStopResult, type ClosureRequest, type ControlStore } from '@khala/contracts/messaging/index';
import { createProductionHumanServiceLoader } from '../composition/human/production';
import { createOwnerRoomClosureConnector } from '../composition/owner-mailbox/closure';
import { createControlStore, type BlobsStoreLike } from '../runtime/control-store';
import { readHumanServerEnv } from '../runtime/env';
import type { RouteRegistration } from '../runtime/handler';
import { createChannelClosureHandlers } from './handler';
import { createMatrixClosureTransport } from './matrix';
import { createChannelClosureService } from './service';

/** The mailbox owns enumeration; the adapter accepts only a typed aggregate receipt. */
export function createProtectedClosureConnector(input: Readonly<{
  store: ControlStore; principal: AuthPrincipal; clock: () => number; authoritySecret: string;
}>): Readonly<{ stopDelivery(request: ClosureRequest): Promise<ClosureConnectorStopResult> }> {
  const mailbox = createOwnerRoomClosureConnector(input);
  return {
    async stopDelivery(command) {
      const result = await mailbox.stopDelivery(command);
      if (result.kind !== 'stopped') return result;
      const decoded = decodeClosureConnectorReceipt(result.receipt);
      return decoded.ok ? { kind: 'stopped', receipt: decoded.value } : { kind: 'unavailable' };
    },
  };
}

/**
 * Additive human route producer. It uses the same OIDC service loader as the
 * hosted human flow and the same durable control-state namespaces. No agent
 * registration, browser credential, or Matrix message can invoke this route.
 */
export function registerClosureHandlers(): readonly RouteRegistration[] {
  const loadHuman = createProductionHumanServiceLoader();
  let store: ReturnType<typeof createControlStore> | null = null;
  let homeserverOrigin: string | null = null;
  let authoritySecret: string | null = null;

  return [{
    path: '/api/human/channel-closure',
    methods: ['GET', 'POST'],
    async handle(request) {
      const human = await loadHuman(request);
      if (human === null || !human.messaging) return new Response(JSON.stringify({ code: 'feature_unavailable' }), { status: 503 });
      if (!store || !homeserverOrigin || !authoritySecret) {
        const env = readHumanServerEnv();
        const storeFor = (name: string) => getStore(name) as unknown as BlobsStoreLike;
        store = createControlStore({
          records: storeFor(`${env.controlStateNamespace}-records`),
          operations: storeFor(`${env.controlStateNamespace}-operations`),
          clock: () => Date.now(),
        });
        homeserverOrigin = env.publicHomeserverOrigin;
        authoritySecret = env.invitationHmacSecret;
      }
      const activeStore = store;
      const activeOrigin = homeserverOrigin;
      const activeSecret = authoritySecret;
      const handlers = createChannelClosureHandlers({
        auth: human.auth,
        service: principal => createChannelClosureService({
          principal,
          store: activeStore,
          transport: createMatrixClosureTransport({
            principal, sessions: human.messaging!, homeserverOrigin: activeOrigin,
            connector: createProtectedClosureConnector({
              store: activeStore, principal, clock: () => Date.now(), authoritySecret: activeSecret,
            }),
          }),
        }),
      });
      return handlers[0]!.handle(request);
    },
  }];
}
