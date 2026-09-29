import { randomBytes } from 'node:crypto';
import type { JsonValue } from '@khala/contracts/messaging/index';
import { guardStore, settleWrite } from '../auth/store';
import { createChannelDiscoveryBootstrapHandlers, AUTHORIZE_PATH, TOKEN_PATH,
  type DiscoveryCredentialAuthorization, type DiscoveryAttemptLimiter } from '../channel-discovery/bootstrap/handler';
import type { RouteRegistration } from '../runtime/handler';
import { createHostedProofKeyAuthority } from './hosted-proof-key-authority';
import type { AgentChannelAccessAuthentication } from '../channel-access/handler';
import { AGENT_CHANNEL_ACCESS_CREATE_PATH, AGENT_CHANNEL_ACCESS_REQUEST_PATH,
  AGENT_CHANNEL_ACCESS_STATUS_PATH } from '../channel-access/handler';
import { createProductionHumanRuntimeLoader, type ProductionHumanDependencies,
  type ProductionHumanRuntime } from './human/production';

const GLOBAL_ATTEMPTS_PER_MINUTE = 300;

/** A conservative durable global budget; no client-controlled header chooses the bucket. */
function limiter(active: ProductionHumanRuntime): DiscoveryAttemptLimiter {
  const store = guardStore(active.store);
  return {
    async reserve() {
      const window = Math.floor(active.clock() / 60_000);
      const key = `channel-discovery:hosted-attempts:${window}`;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const read = await store.read<JsonValue>(key);
        if (read.kind === 'unavailable') return { kind: 'unavailable' };
        const count = read.kind === 'record' && typeof read.record.value === 'number' ? read.record.value : 0;
        if (read.kind === 'record' && typeof read.record.value !== 'number') return { kind: 'unavailable' };
        if (count >= GLOBAL_ATTEMPTS_PER_MINUTE) return { kind: 'limited' };
        const id = randomBytes(16).toString('base64url');
        const written = await settleWrite<JsonValue>(store, { key,
          expectedRevision: read.kind === 'record' ? read.record.revision : null,
          operationId: `discovery-hosted-budget:${id}`,
          next: { value: count + 1, expiresAt: new Date((window + 2) * 60_000).toISOString() },
        });
        if (written.kind === 'applied') return { kind: 'reserved', permit: { permitId: id } };
        if (written.kind === 'unavailable') return { kind: 'unavailable' };
      }
      return { kind: 'unavailable' };
    },
    async finalize(input) {
      // The reservation is charged on reserve, regardless of the outcome.
      return { kind: input.disposition === 'release' ? 'released' : 'finalized' };
    },
  };
}

/** Owner consent and signed credential exchange share the durable proof-key authority. */
export function createHostedDiscoveryBootstrap(dependencies: ProductionHumanDependencies = {}) {
  const runtime = createProductionHumanRuntimeLoader(dependencies);
  const compose = () => {
    const active = runtime();
    return createChannelDiscoveryBootstrapHandlers({
      origin: active.env.publicAppOrigin, store: active.store, clock: active.clock,
      random: dependencies.random ?? (bytes => randomBytes(bytes)),
      authenticate: request => active.auth.authenticateRequest(request),
      sessionAuthority: createHostedProofKeyAuthority(active),
      trustedSource: async () => ({ kind: 'trusted', source: 'hosted-function' }),
      limiter: limiter(active),
    });
  };
  const unavailable = () => new Response(JSON.stringify({ kind: 'unavailable' }), {
    status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
  const lazy = (path: string, methods: readonly string[], kind: 'human' | 'agent'): RouteRegistration => ({
    path, methods,
    async handle(request) {
      try {
        const route = compose()[kind].find(item => item.path === path);
        return route ? await route.handle(request) : unavailable();
      } catch { return unavailable(); }
    },
  });
  const authorize = async (request: Request, action: string): Promise<DiscoveryCredentialAuthorization> => {
    try { return await compose().credentials.authorize(request, action); }
    catch { return { kind: 'unavailable' }; }
  };
  return {
    human: Object.freeze([lazy(AUTHORIZE_PATH, ['GET', 'POST'], 'human')]),
    agent: Object.freeze([lazy(TOKEN_PATH, ['POST'], 'agent')]),
    authorize,
    authenticateAgent: createDiscoveryChannelAccessAuthentication(authorize),
  };
}

/** Adapter for #520's trusted port; registering its routes still needs the remaining provider ports. */
export function createDiscoveryChannelAccessAuthentication(
  authorize: (request: Request, action: string) => Promise<DiscoveryCredentialAuthorization>,
): (request: Request) => Promise<AgentChannelAccessAuthentication> {
  return async request => {
    let url: URL;
    try { url = new URL(request.url); } catch { return { kind: 'rejected', code: 'forbidden' }; }
    let action: 'request_channel_access' | 'request_channel_create' | null = null;
    if (request.method === 'POST' && url.pathname === AGENT_CHANNEL_ACCESS_REQUEST_PATH) action = 'request_channel_access';
    if (request.method === 'POST' && url.pathname === AGENT_CHANNEL_ACCESS_CREATE_PATH) action = 'request_channel_create';
    if (request.method === 'GET' && url.pathname === AGENT_CHANNEL_ACCESS_STATUS_PATH) {
      const kinds = url.searchParams.getAll('operationKind');
      if (kinds.length === 1 && kinds[0] === 'access') action = 'request_channel_access';
      if (kinds.length === 1 && kinds[0] === 'create') action = 'request_channel_create';
    }
    if (action === null) return { kind: 'rejected', code: 'forbidden' };
    let result: DiscoveryCredentialAuthorization;
    try { result = await authorize(request, action); }
    catch { return { kind: 'unavailable' }; }
    if (result.kind === 'unavailable') return { kind: 'unavailable' };
    if (result.kind === 'refused') return { kind: 'rejected',
      code: result.status === 401 ? 'auth_required' : 'forbidden' };
    const requester = result.requester;
    return { kind: 'authenticated', requester, context: {
      v: 1, principal: requester.principal, origin: requester.origin,
      sessionGeneration: requester.sessionGeneration,
      // The key is the durable identity. Provider session strings are caller labels.
      sessionFingerprint: requester.proofKey.thumbprint,
      harness: 'proof-key', displayLabel: null, workspaceLabel: null,
    } };
  };
}
