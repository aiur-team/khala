// Sign-in begin and callback. The login binding (state, nonce, PKCE verifier and
// return path) lives in the store under the hash of a handle held only in the
// browser's HttpOnly cookie, so a callback completes only in the browser that
// began it. It is consumed exactly once by compare-and-set before the code is
// exchanged, and a session cookie is minted only after identity, owner mapping
// and messaging provisioning all succeed.

import { createHash } from 'node:crypto';
import {
  type AuthPrincipal, type ControlStore, type TrustedClock, isSameOriginReturnPath,
} from '@khala/contracts/messaging/index';
import { type ClaimRejection, checkClaims, resolveOwner } from './principal';
import type { OidcClient } from './provider';
import { type MessagingAccountDirectory, ensureMessagingAccount } from './provisioning';
import { LOGIN_COOKIE, clearCookie, createSession, readCookie, sessionCookie } from './sessions';
import { type Random, TOKEN, derive, orUnavailable, randomToken, settleWrite } from './store';

export const LOGIN_PATH = '/api/human/auth/login';
export const CALLBACK_PATH = '/api/human/auth/callback';

export type SignInDeps = Readonly<{
  oidc: OidcClient;
  store: ControlStore;
  messaging: MessagingAccountDirectory;
  clock: TrustedClock;
  random: Random;
  origin: string;
  sessionTtlMs: number;
  loginTtlMs: number;
}>;

type LoginRecord = {
  v: 1;
  state: string;
  nonce: string;
  codeVerifier: string;
  returnPath: string;
  status: 'pending' | 'consumed';
};

const loginKey = (handle: string) => `auth.login.v1.${derive('login', handle)}`;

export type StartResult =
  | Readonly<{ kind: 'redirect'; location: string; cookies: readonly string[] }>
  | Readonly<{ kind: 'rejected'; code: 'invalid_return_path' }>
  | Readonly<{ kind: 'unavailable' }>;

export async function startSignIn(deps: SignInDeps, returnPath: string): Promise<StartResult> {
  if (!isSameOriginReturnPath(returnPath)) return { kind: 'rejected', code: 'invalid_return_path' };
  const handle = randomToken(deps.random, 32);
  const login: LoginRecord = {
    v: 1,
    state: randomToken(deps.random, 32),
    nonce: randomToken(deps.random, 32),
    codeVerifier: randomToken(deps.random, 32),
    returnPath,
    status: 'pending',
  };
  const expiresAt = new Date(deps.clock() + deps.loginTtlMs).toISOString();
  const write = await settleWrite(deps.store, {
    key: loginKey(handle), expectedRevision: null, operationId: `auth.login.begin.${derive('login', handle)}`,
    next: { value: login, expiresAt },
  });
  if (write.kind !== 'applied') return { kind: 'unavailable' };
  const url = await orUnavailable(() => deps.oidc.authorizationUrl({
    redirectUri: deps.origin + CALLBACK_PATH,
    state: login.state,
    nonce: login.nonce,
    codeChallenge: createHash('sha256').update(login.codeVerifier).digest('base64url'),
    codeChallengeMethod: 'S256',
  }));
  if (url.kind !== 'ok') return { kind: 'unavailable' };
  const maxAge = Math.floor(deps.loginTtlMs / 1000);
  return {
    kind: 'redirect',
    location: url.value,
    cookies: [`${LOGIN_COOKIE}=${handle}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`],
  };
}

export type CallbackRejection =
  | 'login_expired' | 'login_replayed' | 'state_mismatch' | 'provider_denied' | 'invalid_response' | 'mapping_conflict'
  | ClaimRejection;

export type CallbackResult =
  | Readonly<{ kind: 'signed_in'; location: string; cookies: readonly string[]; principal: AuthPrincipal }>
  | Readonly<{ kind: 'rejected'; code: CallbackRejection; cookies: readonly string[] }>
  /** Infrastructure failure (store, provider or messaging); never a sign-out. */
  | Readonly<{ kind: 'unavailable'; cookies: readonly string[] }>;

export async function completeSignIn(deps: SignInDeps, request: Pick<Request, 'url' | 'headers'>): Promise<CallbackResult> {
  const clear = [clearCookie(LOGIN_COOKIE)];
  const reject = (code: CallbackRejection): CallbackResult => ({ kind: 'rejected', code, cookies: clear });
  const handle = readCookie(request.headers.get('cookie'), LOGIN_COOKIE);
  if (handle === null || !TOKEN.test(handle)) return reject('login_expired');
  const key = loginKey(handle);
  const read = await deps.store.read<LoginRecord>(key);
  // Keep the login cookie: the binding may still be intact once the store recovers.
  if (read.kind === 'unavailable') return { kind: 'unavailable', cookies: [] };
  if (read.kind === 'absent') return reject('login_expired');
  const login = read.record.value;
  if (login.status !== 'pending') return reject('login_replayed');
  const callback = new URL(request.url);
  // A forged callback keeps the login cookie, so it cannot cancel a sign-in in progress.
  if (callback.origin + callback.pathname !== deps.origin + CALLBACK_PATH || callback.searchParams.get('state') !== login.state) {
    return { kind: 'rejected', code: 'state_mismatch', cookies: [] };
  }

  // One-time consume. Of any number of concurrent callbacks, exactly one applies.
  // Each attempt has its own operation ID: a shared one would make a concurrent
  // replay look like an idempotent retry of the winning write.
  const consume = await settleWrite(deps.store, {
    key, expectedRevision: read.record.revision, operationId: `auth.login.consume.${randomToken(deps.random, 18)}`,
    next: { value: { ...login, status: 'consumed' }, expiresAt: read.record.expiresAt },
  });
  if (consume.kind === 'conflict') return reject('login_replayed');
  if (consume.kind !== 'applied') return { kind: 'unavailable', cookies: clear };

  const exchanged = await orUnavailable(() => deps.oidc.exchangeCode({
    callbackUrl: request.url,
    redirectUri: deps.origin + CALLBACK_PATH,
    expectedState: login.state,
    nonce: login.nonce,
    codeVerifier: login.codeVerifier,
  }));
  if (exchanged.kind === 'rejected') return reject(exchanged.code === 'denied' ? 'provider_denied' : 'invalid_response');
  if (exchanged.kind !== 'ok') return { kind: 'unavailable', cookies: clear };

  const nowMs = deps.clock();
  const claims = checkClaims(exchanged.value, { issuer: deps.oidc.issuer, clientId: deps.oidc.clientId, nowMs });
  if (!claims.ok) return reject(claims.code);
  const owner = await resolveOwner(deps.store, deps.random, claims.identity);
  if (owner.kind !== 'owner') return { kind: 'unavailable', cookies: clear };
  const account = await ensureMessagingAccount(deps.store, deps.messaging, deps.random, owner.ownerId);
  if (account.kind === 'conflict') return reject('mapping_conflict');
  if (account.kind !== 'active') return { kind: 'unavailable', cookies: clear };

  const session = await createSession(deps.store, deps.random, {
    ownerId: owner.ownerId, identity: claims.identity, expiresAtMs: nowMs + deps.sessionTtlMs,
  });
  if (session.kind !== 'created') return { kind: 'unavailable', cookies: clear };
  return {
    kind: 'signed_in',
    location: login.returnPath,
    cookies: [sessionCookie(session.token, Math.floor(deps.sessionTtlMs / 1000)), ...clear],
    principal: session.principal,
  };
}
