// Public surface of the human auth module (KHA-110). Request-lifetime control
// functions bind these to routes; this module owns no HTTP server, provider
// library or storage adapter. Everything is injected.

import {
  type AuthPrincipal, type ControlStore, type IdentityPort, type IdentityState, type OwnerId, type SignInIntent, type TrustedClock,
  isSameOriginReturnPath, ok, rejected, unavailable,
} from '@khala/contracts/messaging/index';
import { type CallbackResult, LOGIN_PATH, type SignInDeps, type StartResult, completeSignIn, startSignIn } from './callback';
import { CSRF_HEADER, checkMutationOrigin, csrfMatches } from './csrf';
import type { OidcClient } from './provider';
import { type MessagingAccountDirectory, readMessagingAccount } from './provisioning';
import { SESSION_COOKIE, clearCookie, csrfTokenFor, lookupSession, revokeSession } from './sessions';
import { type Random, guardStore } from './store';

export type { AuthorizationRequest, CodeExchange, OidcClient, ProviderRejection, ProviderResult } from './provider';
export type { MessagingAccountDirectory } from './provisioning';
export type { CallbackRejection, CallbackResult, StartResult } from './callback';
export type { ClaimRejection } from './principal';
export type { Random } from './store';
export { CALLBACK_PATH, LOGIN_PATH } from './callback';
export { CSRF_HEADER } from './csrf';
export { LOGIN_COOKIE, SESSION_COOKIE } from './sessions';

/** Stable failure codes only: never a token, cookie, claim value or provider message. */
export type AuthDiagnostic = Readonly<{ event: 'sign_in' | 'callback' | 'authenticate' | 'mutation' | 'sign_out'; code: string; requestId: string | null }>;

export type AuthServiceOptions = Readonly<{
  oidc: OidcClient;
  store: ControlStore;
  messaging: MessagingAccountDirectory;
  clock: TrustedClock;
  random: Random;
  /** Exact public origin, e.g. `https://khala.aiur.team`. The callback is `${origin}/api/human/auth/callback`. */
  origin: string;
  /** Configured session lifetime; the module has no default so the deployment records its policy. */
  sessionTtlMs: number;
  loginTtlMs: number;
  log?: (entry: AuthDiagnostic) => void;
}>;

export type HumanContext = Readonly<{ principal: AuthPrincipal; csrfToken: string }>;

export type Authentication =
  | Readonly<{ kind: 'authenticated'; context: HumanContext }>
  | Readonly<{ kind: 'signed_out' }>
  /** Identity could not be determined. Never render this as signed out. */
  | Readonly<{ kind: 'unavailable' }>;

export type MutationAuthorization =
  | Readonly<{ kind: 'authorized'; context: HumanContext }>
  | Readonly<{ kind: 'rejected'; code: 'not_a_mutation' | 'forbidden_origin' | 'signed_out' | 'csrf_mismatch' }>
  | Readonly<{ kind: 'unavailable' }>;

export type SignOutResult =
  | Readonly<{ kind: 'signed_out'; cookies: readonly string[] }>
  | Readonly<{ kind: 'rejected'; code: 'not_a_mutation' | 'forbidden_origin' | 'csrf_mismatch' }>
  | Readonly<{ kind: 'unavailable' }>
  /** Keep the operation ID and retry with it; the revocation may have landed. */
  | Readonly<{ kind: 'outcome_unknown'; operationId: string }>;

type AuthRequest = Pick<Request, 'method' | 'url' | 'headers'>;

export interface AuthService {
  /** Begin sign-in. `returnPath` must be a same-origin absolute path. */
  startSignIn(returnPath: string, request?: AuthRequest): Promise<StartResult>;
  completeSignIn(request: AuthRequest): Promise<CallbackResult>;
  authenticateRequest(request: AuthRequest): Promise<Authentication>;
  /** Origin, fetch metadata, session and CSRF, in that order. Body fields carry no authority. */
  requireHumanMutation(request: AuthRequest): Promise<MutationAuthorization>;
  signOut(request: AuthRequest, operationId: string): Promise<SignOutResult>;
  /** The owner's messaging account mapping, for composition code. */
  messagingAccount(ownerId: OwnerId): ReturnType<typeof readMessagingAccount>;
  /** Request-scoped `IdentityPort` for server-side composition. */
  identityFor(request: AuthRequest): IdentityPort;
}

export function createAuthService(options: AuthServiceOptions): AuthService {
  const origin = new URL(options.origin);
  if (origin.protocol !== 'https:' || origin.origin !== options.origin) {
    throw new Error('auth origin must be an exact https origin');
  }
  for (const ttl of [options.sessionTtlMs, options.loginTtlMs]) {
    if (!Number.isSafeInteger(ttl) || ttl < 1000) throw new Error('auth lifetimes must be whole milliseconds of at least one second');
  }
  const store = guardStore(options.store);
  const deps: SignInDeps = { ...options, store };
  const log = (request: AuthRequest | undefined, event: AuthDiagnostic['event'], code: string) => {
    try {
      options.log?.({ event, code, requestId: request ? requestIdOf(request) : null });
    } catch {
      // Diagnostics never change an auth outcome.
    }
  };

  async function authenticateRequest(request: AuthRequest): Promise<Authentication> {
    const session = await lookupSession(store, request.headers.get('cookie'), options.clock());
    if (session.kind !== 'authenticated') {
      if (session.kind === 'unavailable') log(request, 'authenticate', 'store_unavailable');
      return session;
    }
    return { kind: 'authenticated', context: { principal: session.principal, csrfToken: csrfTokenFor(session.token) } };
  }

  async function requireHumanMutation(request: AuthRequest): Promise<MutationAuthorization> {
    const originCheck = checkMutationOrigin(request, options.origin);
    if (originCheck !== 'ok') {
      log(request, 'mutation', originCheck);
      return { kind: 'rejected', code: originCheck };
    }
    const session = await lookupSession(store, request.headers.get('cookie'), options.clock());
    if (session.kind === 'unavailable') {
      log(request, 'mutation', 'store_unavailable');
      return session;
    }
    if (session.kind === 'signed_out') return { kind: 'rejected', code: 'signed_out' };
    const csrfToken = csrfTokenFor(session.token);
    if (!csrfMatches(request.headers.get(CSRF_HEADER), csrfToken)) {
      log(request, 'mutation', 'csrf_mismatch');
      return { kind: 'rejected', code: 'csrf_mismatch' };
    }
    return { kind: 'authorized', context: { principal: session.principal, csrfToken } };
  }

  async function signOut(request: AuthRequest, operationId: string): Promise<SignOutResult> {
    const originCheck = checkMutationOrigin(request, options.origin);
    if (originCheck !== 'ok') {
      log(request, 'sign_out', originCheck);
      return { kind: 'rejected', code: originCheck };
    }
    const cleared = [clearCookie(SESSION_COOKIE)];
    const session = await lookupSession(store, request.headers.get('cookie'), options.clock());
    if (session.kind === 'unavailable') {
      log(request, 'sign_out', 'store_unavailable');
      return session;
    }
    // Already signed out, expired, or revoked by an earlier attempt of this operation.
    if (session.kind === 'signed_out') return { kind: 'signed_out', cookies: cleared };
    if (!csrfMatches(request.headers.get(CSRF_HEADER), csrfTokenFor(session.token))) {
      log(request, 'sign_out', 'csrf_mismatch');
      return { kind: 'rejected', code: 'csrf_mismatch' };
    }
    const revoked = await revokeSession(store, session.token, operationId);
    if (revoked.kind === 'revoked') return { kind: 'signed_out', cookies: cleared };
    log(request, 'sign_out', revoked.kind);
    return revoked.kind === 'unavailable' ? revoked : { kind: 'outcome_unknown', operationId };
  }

  const service: AuthService = {
    async startSignIn(returnPath, request) {
      const result = await startSignIn(deps, returnPath);
      if (result.kind !== 'redirect') log(request, 'sign_in', result.kind === 'rejected' ? result.code : 'unavailable');
      return result;
    },
    async completeSignIn(request) {
      const result = await completeSignIn(deps, request);
      if (result.kind !== 'signed_in') log(request, 'callback', result.kind === 'rejected' ? result.code : 'unavailable');
      return result;
    },
    authenticateRequest,
    requireHumanMutation,
    signOut,
    messagingAccount: ownerId => readMessagingAccount(store, ownerId),
    identityFor(request) {
      return {
        async current(): Promise<IdentityState> {
          const auth = await authenticateRequest(request);
          if (auth.kind === 'authenticated') return { kind: 'signed_in', principal: auth.context.principal };
          return auth.kind === 'signed_out' ? auth : { kind: 'unavailable', retryable: true };
        },
        async beginSignIn(returnPath) {
          if (!isSameOriginReturnPath(returnPath)) return rejected('invalid_return_path');
          // The host navigates to the login route, which sets the binding cookie and redirects on.
          return ok<SignInIntent>({ kind: 'navigate', url: `${options.origin}${LOGIN_PATH}?return_to=${encodeURIComponent(returnPath)}` });
        },
        async signOut(operationId) {
          const result = await signOut(request, operationId);
          if (result.kind === 'signed_out') return ok(null);
          if (result.kind === 'outcome_unknown') return result;
          // The port has no refusal code. A request that fails the mutation guard
          // leaves the session untouched, so report that nothing was done.
          return unavailable();
        },
      };
    },
  };
  return service;
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Platform request ID for correlating diagnostics; anything unexpected is dropped, not echoed. */
function requestIdOf(request: AuthRequest): string | null {
  const id = request.headers.get('x-nf-request-id') ?? request.headers.get('x-request-id');
  return id !== null && REQUEST_ID.test(id) ? id : null;
}
