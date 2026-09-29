import { createHash } from 'node:crypto';
import type { ChannelAccessResolutionPort } from '@khala/contracts/messaging/index';
import type { ChannelAdmissionProviderPort } from '@khala/messaging/channel-access/exchange/ports';
import { createChannelAccessPolicy } from '@khala/messaging/channel-access/journal/policy';
import { createChannelAccessService } from '@khala/messaging/channel-access/journal/service';
import { createChannelAccessStore } from '@khala/messaging/channel-access/journal/store';
import type { AdapterCapabilities } from '../../agent-bootstrap/handler';
import { createChannelAccessHandlers, type ChannelAccessHandlerDependencies } from '../../channel-access/handler';
import type { GrantExchangeHandlerDependencies } from '../../channel-access/exchange/handler';
import { composeChannelAccessExchange } from '../agent/channel-access-exchange';
import type { RouteRegistration } from '../../runtime/handler';
import { createProductionHumanRuntimeLoader, type ProductionHumanDependencies, type ProductionHumanRuntime } from './production';

/**
 * The hosted integration supplies these trusted ports. #42's native-session
 * authority must verify the exact current session, credential scope/expiry
 * and sender-bound proof; connector authentication must also verify the exact
 * device and proof key. Resolution and admission remain hosted concerns. An
 * invitation URL is never agent authentication or connector proof.
 */
export type HostedChannelAccessPorts = Readonly<{
  authenticateAgent: ChannelAccessHandlerDependencies['authenticateAgent'];
  authenticateConnector: GrantExchangeHandlerDependencies['authenticateConnector'];
  resolver(runtime: ProductionHumanRuntime): ChannelAccessResolutionPort;
  provider: ChannelAdmissionProviderPort;
  bindings: Pick<AdapterCapabilities, 'resumeAdapterCapability'>;
}>;

const unavailable = () => new Response(JSON.stringify({ v: 1, kind: 'unavailable' }), {
  status: 503,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
});

/**
 * Request-lifetime composition. All routes share the production Blobs
 * namespace, OIDC session service and journal policy. A broken adapter or
 * missing storage fails closed without exposing a partial approval or grant.
 */
export function createHostedChannelAccessRoutes(
  dependencies: ProductionHumanDependencies,
  ports: HostedChannelAccessPorts,
): Readonly<{ human: readonly RouteRegistration[]; agent: readonly RouteRegistration[]; exchange: readonly RouteRegistration[] }> {
  const runtime = createProductionHumanRuntimeLoader(dependencies);
  function compose() {
    const active = runtime();
    const key = createHash('sha256').update('khala.hosted.channel-access.policy.v1\0')
      .update(active.env.invitationHmacSecret).digest();
    const policy = createChannelAccessPolicy({ key });
    const journal = createChannelAccessStore({ store: active.store, policy, clock: active.clock });
    const service = createChannelAccessService({ store: journal, resolver: ports.resolver(active), policy });
    const handlers = createChannelAccessHandlers({
      service, auth: active.auth,
      async authenticateAgent(request) {
        const result = await ports.authenticateAgent(request);
        if (result.kind === 'authenticated'
          && (result.requester.origin !== active.env.publicAppOrigin
            || result.context.origin !== active.env.publicAppOrigin)) {
          return { kind: 'rejected', code: 'forbidden' };
        }
        return result;
      },
    });
    const exchange = composeChannelAccessExchange({
      store: active.store, journal, fulfillment: service.fulfillment,
      provider: ports.provider, bindings: ports.bindings,
      async authenticateConnector(request) {
        const result = await ports.authenticateConnector(request);
        return result.kind === 'authenticated' && result.connector.origin !== active.env.publicAppOrigin
          ? { kind: 'rejected', code: 'forbidden' } : result;
      },
      clock: active.clock,
    });
    return { handlers, exchange };
  }
  function lazy(path: string, methods: readonly string[], select: (composed: ReturnType<typeof compose>) => readonly RouteRegistration[]): RouteRegistration {
    return Object.freeze({
      path, methods: Object.freeze([...methods]),
      async handle(request: Request) {
        try {
          const route = select(compose()).find(item => item.path === path);
          return route ? await route.handle(request) : unavailable();
        } catch {
          return unavailable();
        }
      },
    });
  }
  const agent = [
    lazy('/api/agent/channel-access/request', ['POST'], value => value.handlers.agent),
    lazy('/api/agent/channel-access/create', ['POST'], value => value.handlers.agent),
    lazy('/api/agent/channel-access/status', ['GET'], value => value.handlers.agent),
  ];
  const human = [
    lazy('/api/human/channel-access/decision', ['POST'], value => value.handlers.human),
    lazy('/api/human/channel-access/mute', ['POST'], value => value.handlers.human),
  ];
  const exchange = [
    lazy('/api/agent/channel-access/exchange', ['POST'], value => value.exchange),
    lazy('/api/agent/channel-access/ready', ['POST'], value => value.exchange),
    lazy('/api/agent/channel-access/resume', ['POST'], value => value.exchange),
  ];
  return Object.freeze({ human: Object.freeze(human), agent: Object.freeze(agent), exchange: Object.freeze(exchange) });
}
