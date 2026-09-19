import { randomBytes } from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { createAuthService } from '../../auth/index';
import { createOidcClient } from '../../auth/oidc';
import { createAdmissionService } from '../../invitations/index';
import { createControlStore, type BlobsStoreLike } from '../../runtime/control-store';
import { readServerEnv } from '../../runtime/env';
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

type Runtime = Readonly<{
  auth: ReturnType<typeof createAuthService>;
  store: ReturnType<typeof createControlStore>;
  matrix: ReturnType<typeof createMatrixHumanServices>;
  env: ReturnType<typeof readServerEnv>;
  clock: () => number;
}>;

/**
 * Lazily binds the production OIDC, Blobs and Matrix adapters on the first
 * request. Importing or discovering handlers performs no network or store I/O.
 */
export function createProductionHumanServiceLoader(dependencies: ProductionHumanDependencies = {}): LoadHumanServices {
  let runtime: Runtime | null = null;

  function initialize(): Runtime {
    if (runtime !== null) return runtime;
    const env = readServerEnv(dependencies.env);
    const clock = dependencies.clock ?? (() => Date.now());
    const random = dependencies.random ?? (bytes => randomBytes(bytes));
    const storeFor = dependencies.stores ?? (name => getStore(name) as unknown as BlobsStoreLike);
    const store = createControlStore({
      records: storeFor(`${env.controlStateNamespace}-records`),
      operations: storeFor(`${env.controlStateNamespace}-operations`),
      clock,
    });
    const matrix = createMatrixHumanServices({
      homeserverOrigin: env.publicHomeserverOrigin,
      serverName: env.matrixServerName,
      registrationSharedSecret: env.matrixRegistrationSharedSecret,
      passwordDerivationSecret: env.matrixPasswordDerivationSecret,
      ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
    });
    const oidc = createOidcClient({
      issuer: env.oidcIssuer,
      clientId: env.oidcClientId,
      clientSecret: env.oidcClientSecret,
      clock,
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
    });
    runtime = { auth, store, matrix, env, clock };
    return runtime;
  }

  return async function load(request: Request): Promise<HumanHandlerServices> {
    const active = initialize();
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
