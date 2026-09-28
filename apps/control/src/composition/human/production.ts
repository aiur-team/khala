import { randomBytes } from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { createAuthService } from '../../auth/index';
import { createOidcClient } from '../../auth/oidc';
import { createLocalOidcClient, localOidcEnabled } from '../../auth/local-oidc';
import { createAdmissionService } from '../../invitations/index';
import { createControlStore, type BlobsStoreLike } from '../../runtime/control-store';
import { localBlobStores } from '../../runtime/local-blob-store';
import { readHumanServerEnv } from '../../runtime/env';
import type { HumanHandlerServices, LoadHumanServices } from './handlers';
import { createMatrixHumanServices } from './matrix';

const SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
const LOGIN_TTL_MS = 10 * 60 * 1_000;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export type ProductionHumanDependencies = Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
  stores?: (name: string) => BlobsStoreLike;
  clock?: () => number;
  random?: (bytes: number) => Uint8Array;
  fetch?: typeof globalThis.fetch;
}>;

export type ProductionHumanRuntime = Readonly<{
  auth: ReturnType<typeof createAuthService>;
  store: ReturnType<typeof createControlStore>;
  matrix: ReturnType<typeof createMatrixHumanServices>;
  env: ReturnType<typeof readHumanServerEnv>;
  clock: () => number;
}>;

/**
 * Lazily binds the production OIDC, Blobs and Matrix adapters on the first
 * request. Importing or discovering handlers performs no network or store I/O.
 */
export function createProductionHumanServiceLoader(dependencies: ProductionHumanDependencies = {}): LoadHumanServices {
  const loadRuntime = createProductionHumanRuntimeLoader(dependencies);
  return async function load(request: Request): Promise<HumanHandlerServices> {
    const active = loadRuntime();
    return {
      auth: active.auth,
      admission: createAdmissionService({
        store: active.store,
        identity: active.auth.identityFor(request),
        authority: active.matrix.authority,
        gateway: active.matrix.gateway,
        clock: active.clock,
        origin: active.env.publicAppOrigin,
        allowedOrigins: [active.env.publicAppOrigin],
        secret: active.env.invitationHmacSecret,
        inviteLifetimeMs: INVITE_TTL_MS,
      }),
      messaging: active.matrix.sessions,
    };
  };
}

/** Shared lazy production adapters for request-scoped feature composition. */
export function createProductionHumanRuntimeLoader(dependencies: ProductionHumanDependencies = {}): () => ProductionHumanRuntime {
  let runtime: ProductionHumanRuntime | null = null;

  function initialize(): ProductionHumanRuntime {
    if (runtime !== null) return runtime;
    const rawEnv = dependencies.env ?? process.env;
    const localAuth = localOidcEnabled(rawEnv);
    const env = readHumanServerEnv(rawEnv);
    const clock = dependencies.clock ?? (() => Date.now());
    const random = dependencies.random ?? (bytes => randomBytes(bytes));
    const storeFor = dependencies.stores ?? (localAuth ? localBlobStores : (name => getStore(name) as unknown as BlobsStoreLike));
    const store = createControlStore({
      records: storeFor(`${env.controlStateNamespace}-records`),
      operations: storeFor(`${env.controlStateNamespace}-operations`),
      clock,
    });
    const matrix = createMatrixHumanServices({
      homeserverOrigin: env.publicHomeserverOrigin,
      allowInsecureLoopback: localAuth,
      serverName: env.matrixServerName,
      registrationSharedSecret: env.matrixRegistrationSharedSecret,
      registrationIngressToken: env.matrixRegistrationIngressToken,
      passwordDerivationSecret: env.matrixPasswordDerivationSecret,
      store,
      ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
    });
    const oidc = localAuth ? createLocalOidcClient(env.publicAppOrigin, rawEnv.KHALA_LOCAL_AUTH_EMAIL ?? 'owner@khala.local') : createOidcClient({
      issuer: env.oidcIssuer,
      clientId: env.oidcClientId,
      clientSecret: env.oidcClientSecret,
      clock,
      onFailure: diagnostic => console.warn('Khala OIDC callback failed', JSON.stringify(diagnostic)),
      ...(dependencies.fetch ? { fetch: dependencies.fetch as never } : {}),
    });
    const auth = createAuthService({
      oidc,
      store,
      messaging: matrix.directory,
      clock,
      random,
      origin: env.publicAppOrigin,
      sessionTtlMs: SESSION_TTL_MS,
      loginTtlMs: LOGIN_TTL_MS,
      allowInsecureLoopback: localAuth,
      log: entry => {
        if (entry.event === 'callback') console.warn('Khala auth callback', JSON.stringify({ stage: entry.code }));
      },
    });
    runtime = { auth, store, matrix, env, clock };
    return runtime;
  }

  return initialize;
}
