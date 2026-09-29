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
import { createHostedChannelAdmissionProvider, type HostedAdmissionAuthority } from '../agent/hosted-channel-admission';
import type { RouteRegistration } from '../../runtime/handler';
import { createProductionHumanRuntimeLoader, type ProductionHumanDependencies, type ProductionHumanRuntime } from './production';
import { createHostedChannelAccessResolver, type HostedAccessRequesterAuthority } from './hosted-channel-access-resolver';

/**
 * The hosted integration supplies approved proof-key authority and fresh
 * request-bound credential proof. Connector authentication separately verifies
 * the current approved key, generation and device. An invitation URL is only
 * a channel locator, never agent or connector authentication.
 */
export type HostedChannelAccessPorts = Readonly<{
  authenticateAgent?: ChannelAccessHandlerDependencies['authenticateAgent'];
  /** Creates request-scoped signed discovery authority and its durable recheck port. */
  hostedAuthority?: (runtime: ProductionHumanRuntime) => Readonly<{
    authenticateAgent: ChannelAccessHandlerDependencies['authenticateAgent'];
    requesterAuthority: HostedAccessRequesterAuthority;
    admissionAuthority?: HostedAdmissionAuthority;
  }>;
  requesterAuthority?: HostedAccessRequesterAuthority;
  /** Controlled test override; production supplies the current requester authority. */
  resolver?(runtime: ProductionHumanRuntime): ChannelAccessResolutionPort;
  /** Controlled test override; production uses the hosted Matrix adapter. */
  provider?: ChannelAdmissionProviderPort;
  /** Required for real Matrix admission; checks the current owner/key/session approval at the effect boundary. */
  admissionAuthority?: HostedAdmissionAuthority;
  authenticateConnector?: GrantExchangeHandlerDependencies['authenticateConnector'];
  bindings?: Pick<AdapterCapabilities, 'resumeAdapterCapability'>;
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
    const hostedAuthority = ports.hostedAuthority?.(active);
    const authenticateAgent = hostedAuthority?.authenticateAgent ?? ports.authenticateAgent;
    const requesterAuthority = hostedAuthority?.requesterAuthority ?? ports.requesterAuthority;
    if (!authenticateAgent) throw new Error('agent authentication unavailable');
    const resolver = ports.resolver?.(active) ?? (requesterAuthority
      ? createHostedChannelAccessResolver(active, requesterAuthority) : null);
    if (resolver === null) throw new Error('requester authority unavailable');
    const service = createChannelAccessService({ store: journal, resolver, policy });
    const handlers = createChannelAccessHandlers({
      service, auth: active.auth,
      async authenticateAgent(request) {
        const result = await authenticateAgent(request);
        if (result.kind === 'authenticated'
          && (result.requester.origin !== active.env.publicAppOrigin
            || result.context.origin !== active.env.publicAppOrigin)) {
          return { kind: 'rejected', code: 'forbidden' };
        }
        return result;
      },
    });
    const authenticateConnector = ports.authenticateConnector;
    const admissionAuthority = hostedAuthority?.admissionAuthority ?? ports.admissionAuthority;
    const provider = ports.provider ?? (admissionAuthority
      ? createHostedChannelAdmissionProvider(active, dependencies, admissionAuthority) : null);
    if (authenticateConnector && ports.bindings && provider === null) throw new Error('admission authority unavailable');
    const exchange = authenticateConnector && ports.bindings && provider ? composeChannelAccessExchange({
      store: active.store, journal, fulfillment: service.fulfillment,
      provider, bindings: ports.bindings,
      async authenticateConnector(request) {
        const result = await authenticateConnector(request);
        return result.kind === 'authenticated' && result.connector.origin !== active.env.publicAppOrigin
          ? { kind: 'rejected', code: 'forbidden' } : result;
      },
      clock: active.clock,
    }) : [];
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
    lazy('/api/human/channel-access/inbox', ['GET'], value => value.handlers.human),
    lazy('/api/human/channel-access/decision', ['POST'], value => value.handlers.human),
    lazy('/api/human/channel-access/mute', ['POST'], value => value.handlers.human),
  ];
  const exchange = ports.authenticateConnector && ports.bindings ? [
    lazy('/api/agent/channel-access/exchange', ['POST'], value => value.exchange),
    lazy('/api/agent/channel-access/ready', ['POST'], value => value.exchange),
    lazy('/api/agent/channel-access/resume', ['POST'], value => value.exchange),
  ] : [];
  return Object.freeze({ human: Object.freeze(human), agent: Object.freeze(agent), exchange: Object.freeze(exchange) });
}
