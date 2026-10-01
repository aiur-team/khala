import { getStore } from '@netlify/blobs';
import { decodeClosureConnectorReceipt, type AuthPrincipal, type ClosureConnectorStopResult, type ClosureRequest, type ControlStore } from '@khala/contracts/messaging/index';
import { createProductionHumanServiceLoader } from '../composition/human/production';
import { createOwnerRoomClosureConnector } from '../composition/owner-mailbox/closure';
import { createControlStore, type BlobsStoreLike } from '../runtime/control-store';
import { localBlobStores } from '../runtime/local-blob-store';
import { readHumanServerEnv } from '../runtime/env';
import { localOidcEnabled } from '../auth/local-oidc';
import type { RouteRegistration } from '../runtime/handler';
import { createChannelClosureHandlers } from './handler';
import { createOwnerCleanupRequests } from './cleanup-requests';
import { createMatrixClosureTransport } from './matrix';
import { createChannelClosureService } from './service';

type ClosureDiagnosticStage = 'feature_unavailable' | 'authentication_unavailable' | 'cleanup_unavailable'
  | 'cleanup_rejected' | 'loader_rejected' | 'environment_rejected' | 'store_initialize_failed'
  | 'store_record_corrupt' | 'store_read_error';

function closureDiagnostic(stage: ClosureDiagnosticStage, httpStatus?: number): void {
  // Only fixed internal stages and a numeric provider status may reach logs.
  try {
    console.info(JSON.stringify({ component: 'channel-closure', stage,
      ...(httpStatus === undefined ? {} : { httpStatus }) }));
  } catch { /* Diagnostics cannot change the response. */ }
}

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
type ProductionClosureDependencies = Readonly<{
  loadHuman?: ReturnType<typeof createProductionHumanServiceLoader>;
  readEnv?: () => ReturnType<typeof readHumanServerEnv>;
  stores?: (name: string) => BlobsStoreLike;
  env?: NodeJS.ProcessEnv;
}>;

export function registerClosureHandlers(dependencies: ProductionClosureDependencies = {}): readonly RouteRegistration[] {
  const loadHuman = dependencies.loadHuman ?? createProductionHumanServiceLoader();
  let store: ReturnType<typeof createControlStore> | null = null;
  let homeserverOrigin: string | null = null;
  let authoritySecret: string | null = null;

  return [{
    path: '/api/human/channel-closure',
    methods: ['GET', 'POST'],
    async handle(request) {
      let human: Awaited<ReturnType<typeof loadHuman>>;
      try { human = await loadHuman(request); }
      catch {
        closureDiagnostic('loader_rejected');
        return new Response(JSON.stringify({ code: 'unavailable' }), { status: 503 });
      }
      if (human === null || !human.messaging) {
        closureDiagnostic('feature_unavailable');
        return new Response(JSON.stringify({ code: 'feature_unavailable' }), { status: 503 });
      }
      if (!store || !homeserverOrigin || !authoritySecret) {
        let env: ReturnType<typeof readHumanServerEnv>;
        try { env = (dependencies.readEnv ?? readHumanServerEnv)(); }
        catch {
          closureDiagnostic('environment_rejected');
          return new Response(JSON.stringify({ code: 'unavailable' }), { status: 503 });
        }
        try {
          const storeFor = dependencies.stores ?? (localOidcEnabled(dependencies.env ?? process.env)
            ? localBlobStores : (name: string) => getStore(name) as unknown as BlobsStoreLike);
          // A warm function retains the control adapter, but Netlify's Blobs
          // credential belongs to the current invocation. Bind at each operation.
          const contextualStore = (name: string): BlobsStoreLike => ({
            getWithMetadata: (key, options) => storeFor(name).getWithMetadata(key, options),
            setJSON: (key, data, options) => storeFor(name).setJSON(key, data, options),
          });
          store = createControlStore({
            records: contextualStore(`${env.controlStateNamespace}-records`),
            operations: contextualStore(`${env.controlStateNamespace}-operations`),
            clock: () => Date.now(),
            diagnostic: entry => closureDiagnostic(`store_${entry.stage}`, entry.httpStatus),
          });
        } catch {
          closureDiagnostic('store_initialize_failed');
          return new Response(JSON.stringify({ code: 'unavailable' }), { status: 503 });
        }
        homeserverOrigin = env.publicHomeserverOrigin;
        authoritySecret = env.invitationHmacSecret;
      }
      const activeStore = store;
      const activeOrigin = homeserverOrigin;
      const activeSecret = authoritySecret;
      const handlers = createChannelClosureHandlers({
        auth: human.auth,
        diagnostic: stage => closureDiagnostic(stage),
        cleanupRequests: principal => createOwnerCleanupRequests(activeStore, principal.ownerId).list(),
        service: principal => createChannelClosureService({
          principal,
          store: activeStore,
          transport: createMatrixClosureTransport({
            principal, sessions: human.messaging!, homeserverOrigin: activeOrigin,
            connector: createProtectedClosureConnector({
              store: activeStore, principal, clock: () => Date.now(), authoritySecret: activeSecret,
            }),
            cleanup: createOwnerCleanupRequests(activeStore, principal.ownerId),
          }),
        }),
      });
      return handlers[0]!.handle(request);
    },
  }];
}
