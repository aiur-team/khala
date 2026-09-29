import { createHash } from 'node:crypto';
import type { ChannelAccessRequestJournalPort, ChannelAccessResolutionPort } from '@khala/contracts/messaging/index';
import type { ChannelAdmissionProviderPort } from '@khala/messaging/channel-access/exchange/ports';
import { createChannelAccessPolicy } from '@khala/messaging/channel-access/journal/policy';
import { createChannelAccessService } from '@khala/messaging/channel-access/journal/service';
import { createChannelAccessStore } from '@khala/messaging/channel-access/journal/store';
import { composeChannelCreate } from '@khala/messaging/channel-create/compose';
import type { AdapterCapabilities } from '../../agent-bootstrap/handler';
import { createChannelAccessHandlers, type ChannelAccessHandlerDependencies } from '../../channel-access/handler';
import type { GrantExchangeHandlerDependencies } from '../../channel-access/exchange/handler';
import { composeChannelAccessExchange } from '../agent/channel-access-exchange';
import { hostedMatrixChannelCreateAdapter } from '../agent/channel-create';
import { roomFromHostedCreatedRef } from '../agent/channel-create';
import { readHostedCreatedTarget } from '../agent/hosted-created-target';
import { createHostedChannelGrantPort } from '../agent/hosted-channel-grants';
import { agentMatrixIdentity } from '../agent/matrix-admission';
import { createHostedChannelAdmissionProvider, type HostedAdmissionAuthority } from '../agent/hosted-channel-admission';
import type { PairingGrantPort } from '../../pairing/store';
import type { RouteRegistration } from '../../runtime/handler';
import { createProductionHumanRuntimeLoader, type ProductionHumanDependencies, type ProductionHumanRuntime } from './production';
import { createHostedChannelAccessResolver, readHostedAccessTarget, type HostedAccessRequesterAuthority } from './hosted-channel-access-resolver';

function createHostedAccessState(active: ProductionHumanRuntime, resolver: ChannelAccessResolutionPort) {
  const key = createHash('sha256').update('khala.hosted.channel-access.policy.v1\0')
    .update(active.env.invitationHmacSecret).digest();
  const policy = createChannelAccessPolicy({ key });
  const journal = createChannelAccessStore({ store: active.store, policy, clock: active.clock });
  return { journal, service: createChannelAccessService({ store: journal, resolver, policy }) };
}

/** Submit through the same hosted journal and revision checks as the channel-access route. */
export function createHostedAccessRequestJournal(
  active: ProductionHumanRuntime, authority: HostedAccessRequesterAuthority,
): ChannelAccessRequestJournalPort {
  return createHostedAccessState(active, createHostedChannelAccessResolver(active, authority)).service.journal;
}

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
    authenticateConnector?: GrantExchangeHandlerDependencies['authenticateConnector'];
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
): Readonly<{ human: readonly RouteRegistration[]; agent: readonly RouteRegistration[];
  exchange: readonly RouteRegistration[]; grants: PairingGrantPort;
  reconcileCreate(requestHandle: string): Promise<void> }> {
  const runtime = createProductionHumanRuntimeLoader(dependencies);
  function compose() {
    const active = runtime();
    const hostedAuthority = ports.hostedAuthority?.(active);
    const authenticateAgent = hostedAuthority?.authenticateAgent ?? ports.authenticateAgent;
    const requesterAuthority = hostedAuthority?.requesterAuthority ?? ports.requesterAuthority;
    if (!authenticateAgent) throw new Error('agent authentication unavailable');
    const createEnabled = requesterAuthority?.resolveCreateOwner !== undefined
      && typeof active.matrix.channelCreateFor === 'function';
    const resolver = ports.resolver?.(active) ?? (requesterAuthority
      ? createHostedChannelAccessResolver(active, requesterAuthority, createEnabled) : null);
    if (resolver === null) throw new Error('requester authority unavailable');
    const { journal, service } = createHostedAccessState(active, resolver);
    const create = createEnabled ? composeChannelCreate({
      store: active.store, journal,
      service, adapter: hostedMatrixChannelCreateAdapter({ matrix: active.matrix, clock: active.clock }),
      clock: active.clock,
    }) : null;
    const handlers = createChannelAccessHandlers({
      service: create ? { ...service, decisions: create.decisions } : service, auth: active.auth,
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
    const authenticateConnector = hostedAuthority?.authenticateConnector ?? ports.authenticateConnector;
    const admissionAuthority = hostedAuthority?.admissionAuthority ?? ports.admissionAuthority;
    const provider = ports.provider ?? (admissionAuthority
      ? createHostedChannelAdmissionProvider(active, dependencies, admissionAuthority) : null);
    if (authenticateConnector && ports.bindings && provider === null) throw new Error('admission authority unavailable');
    const exchange = authenticateConnector && ports.bindings && provider ? composeChannelAccessExchange({
      store: active.store, journal, fulfillment: service.fulfillment,
      provider, bindings: ports.bindings,
      ...(create ? { authority: create.exchangeAuthority } : {}),
      ...(admissionAuthority ? { approval: async (record, ownerId, channelRef, matrixSession) => {
        const result = await admissionAuthority.current({
          providerOperationId: record.providerOperationId, ownerId: ownerId as never,
          channelRef: channelRef as never, requester: record.requester,
          sessionGeneration: record.sessionGeneration, sessionFingerprint: record.sessionFingerprint,
          deviceId: record.deviceId, history: 'none',
        });
        if (result !== 'current') return result;
        const target = roomFromHostedCreatedRef(channelRef) === null
          ? await readHostedAccessTarget(active, channelRef as never)
          : await readHostedCreatedTarget(active, channelRef, ownerId as never);
        if (target === 'unavailable') return 'unavailable';
        const identity = agentMatrixIdentity(ownerId as never, { harness: 'proof-key', sessionId: record.requester,
          generation: record.sessionGeneration }, active.env.matrixServerName);
        return target?.ownerId === ownerId && target.roomId === matrixSession.roomId
          && matrixSession.userId === identity.userId && matrixSession.baseUrl === active.env.publicHomeserverOrigin
          ? 'current' : 'revoked';
      } } : {}),
      async authenticateConnector(request) {
        const result = await authenticateConnector(request);
        return result.kind === 'authenticated' && result.connector.origin !== active.env.publicAppOrigin
          ? { kind: 'rejected', code: 'forbidden' } : result;
      },
      clock: active.clock,
    }) : [];
    const grants = admissionAuthority && authenticateConnector && ports.bindings
      ? createHostedChannelGrantPort({ active, journal, fulfillment: service.fulfillment, admissionAuthority,
        ...(create ? { createAuthority: create.exchangeAuthority } : {}) }) : null;
    return { handlers, exchange, grants, create };
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
  const exchange = (ports.authenticateConnector || ports.hostedAuthority) && ports.bindings ? [
    lazy('/api/agent/channel-access/exchange', ['POST'], value => value.exchange),
    lazy('/api/agent/channel-access/ready', ['POST'], value => value.exchange),
    lazy('/api/agent/channel-access/resume', ['POST'], value => value.exchange),
  ] : [];
  const grants: PairingGrantPort = {
    async redeem(input) {
      try { return await compose().grants?.redeem(input) ?? { kind: 'unavailable' }; }
      catch { return { kind: 'unavailable' }; }
    },
    async markIssued(input) {
      try { return await compose().grants?.markIssued(input) ?? 'unavailable'; }
      catch { return 'unavailable'; }
    },
  };
  return Object.freeze({ human: Object.freeze(human), agent: Object.freeze(agent),
    exchange: Object.freeze(exchange), grants,
    async reconcileCreate(requestHandle: string) {
      try { await compose().create?.workflow.fulfill(requestHandle); } catch { /* retry through the inbox */ }
    },
  });
}
