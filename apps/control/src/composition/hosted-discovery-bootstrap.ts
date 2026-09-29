import { randomBytes } from 'node:crypto';
import type { JsonValue } from '@khala/contracts/messaging/index';
import { guardStore, settleWrite } from '../auth/store';
import { createChannelDiscoveryBootstrapHandlers, AUTHORIZE_PATH, TOKEN_PATH,
  type DiscoveryCredentialAuthorization, type DiscoveryAttemptLimiter } from '../channel-discovery/bootstrap/handler';
import type { RouteRegistration } from '../runtime/handler';
import { createHostedProofKeyAuthority } from './hosted-proof-key-authority';
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
  return {
    human: Object.freeze([lazy(AUTHORIZE_PATH, ['GET', 'POST'], 'human')]),
    agent: Object.freeze([lazy(TOKEN_PATH, ['POST'], 'agent')]),
    async authorize(request: Request, action: string): Promise<DiscoveryCredentialAuthorization> {
      try { return await compose().credentials.authorize(request, action); }
      catch { return { kind: 'unavailable' }; }
    },
  };
}
