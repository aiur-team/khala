import { randomBytes } from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { createAuthService, type AuthDiagnostic } from '../../auth/index';
import { createOidcClient } from '../../auth/oidc';
import { createAdmissionService } from '../../invitations/index';
import type { ShareDiagnosticStage } from '../../invitations/index';
import { createControlStore, type BlobsStoreLike } from '../../runtime/control-store';
import { readHumanServerEnv } from '../../runtime/env';
import type { HumanHandlerServices, LoadHumanServices } from './handlers';
import { createMatrixHumanServices } from './matrix';

const SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
const LOGIN_TTL_MS = 10 * 60 * 1_000;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

function productionDiagnostic(event: 'runtime' | AuthDiagnostic['event'] | 'share', stage: string, httpStatus?: number): void {
  // The stage is selected from finite internal codes. Never include a request,
  // exception, identity, cookie, room, operation or invitation value.
  console.info(JSON.stringify({ component: 'human', event, stage, ...(httpStatus === undefined ? {} : { httpStatus }) }));
}

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
    let active: ProductionHumanRuntime;
    try {
      active = loadRuntime();
    } catch {
      productionDiagnostic('runtime', 'initialize_failed');
      throw new Error('human runtime unavailable');
    }
    try {
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
          diagnostic: (stage: ShareDiagnosticStage) => productionDiagnostic('share', stage),
        }),
        messaging: active.matrix.sessions,
      };
    } catch {
      productionDiagnostic('runtime', 'admission_initialize_failed');
      throw new Error('human admission unavailable');
    }
  };
}

/** Shared lazy production adapters for request-scoped feature composition. */
export function createProductionHumanRuntimeLoader(dependencies: ProductionHumanDependencies = {}): () => ProductionHumanRuntime {
  let runtime: ProductionHumanRuntime | null = null;

  function initialize(): ProductionHumanRuntime {
    if (runtime !== null) return runtime;
    const env = readHumanServerEnv(dependencies.env);
    const clock = dependencies.clock ?? (() => Date.now());
    const random = dependencies.random ?? (bytes => randomBytes(bytes));
    const storeFor = dependencies.stores ?? (name => getStore(name) as unknown as BlobsStoreLike);
    const store = createControlStore({
      records: storeFor(`${env.controlStateNamespace}-records`),
      operations: storeFor(`${env.controlStateNamespace}-operations`),
      clock,
      diagnostic: entry => productionDiagnostic('runtime', `${entry.scope}_${entry.stage}`, entry.httpStatus),
    });
    const matrix = createMatrixHumanServices({
      homeserverOrigin: env.publicHomeserverOrigin,
      serverName: env.matrixServerName,
      registrationSharedSecret: env.matrixRegistrationSharedSecret,
      registrationIngressToken: env.matrixRegistrationIngressToken,
      passwordDerivationSecret: env.matrixPasswordDerivationSecret,
      store,
      ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
    });
    const oidc = createOidcClient({
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
      log: entry => {
        if (entry.event === 'callback') console.warn('Khala auth callback', JSON.stringify({ stage: entry.code }));
        else productionDiagnostic(entry.event, entry.code);
      },
    });
    runtime = { auth, store, matrix, env, clock };
    return runtime;
  }

  return initialize;
}
