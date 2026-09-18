// Port to a maintained OIDC relying-party client. The adapter owns discovery, the
// code exchange, ID token signature and nonce validation; this module never
// hand-validates a token. What crosses the port is untrusted until `principal.ts`
// re-checks the claims Khala depends on.

import type { CallOptions } from '@khala/contracts/messaging/index';

/** One authorization-code request. `codeChallenge` is S256 over `codeVerifier`. */
export type AuthorizationRequest = Readonly<{
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}>;

/** The callback the browser delivered, plus the transient binding it must satisfy. */
export type CodeExchange = Readonly<{
  callbackUrl: string;
  redirectUri: string;
  expectedState: string;
  nonce: string;
  codeVerifier: string;
}>;

/**
 * - `denied`: the provider or user refused (an `error` callback parameter).
 * - `invalid_response`: the callback, token response or ID token failed validation.
 */
export type ProviderRejection = 'denied' | 'invalid_response';

export type ProviderResult<T> =
  | Readonly<{ kind: 'ok'; value: T }>
  | Readonly<{ kind: 'rejected'; code: ProviderRejection }>
  | Readonly<{ kind: 'unavailable' }>;

export interface OidcClient {
  /** Exact issuer identifier the client was configured for. */
  readonly issuer: string;
  /** OAuth client ID; the expected ID token audience. */
  readonly clientId: string;
  authorizationUrl(request: AuthorizationRequest, options?: CallOptions): Promise<ProviderResult<string>>;
  /**
   * Validates the callback against `expectedState`, exchanges the code with the
   * PKCE `codeVerifier` and `redirectUri`, validates the ID token (signature,
   * issuer, audience, expiry and `nonce`), and returns its claims. When the ID
   * token lacks `email`/`email_verified`, both are taken from userinfo, and only
   * after checking that the userinfo `sub` equals the ID token `sub`. Never
   * returns tokens.
   */
  exchangeCode(exchange: CodeExchange, options?: CallOptions): Promise<ProviderResult<Readonly<Record<string, unknown>>>>;
}
