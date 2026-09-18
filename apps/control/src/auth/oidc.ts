// `OidcClient` over oauth4webapi (version pinned by KHA-144). The library does
// discovery, the callback and token response checks, PKCE, the nonce and the ID
// token signature against the issuer's JWKS; this file only maps its outcomes
// onto the port. Tokens never leave this file.

import * as oauth from 'oauth4webapi';
import type { CallOptions, TrustedClock } from '@khala/contracts/messaging/index';
import type { AuthorizationRequest, CodeExchange, OidcClient, ProviderResult } from './provider';

export type OidcAdapterOptions = Readonly<{
  /** Exact issuer identifier; discovery must return the same value. */
  issuer: string;
  clientId: string;
  /** Confidential clients authenticate with HTTP Basic. Omit for a public client. */
  clientSecret?: string;
  /** Aligns the library's token time checks with the trusted clock. */
  clock?: TrustedClock;
  /** Bound on each provider HTTP call. */
  timeoutMs?: number;
  /** Test seam for the provider's HTTP endpoints. */
  fetch?: (url: string, init: oauth.CustomFetchOptions<string, unknown>) => Promise<Response>;
}>;

type Json = Record<string, unknown>;

const SCOPE = 'openid email';

export function createOidcClient(options: OidcAdapterOptions): OidcClient {
  const issuer = new URL(options.issuer);
  const clientAuth = options.clientSecret === undefined ? oauth.None() : oauth.ClientSecretBasic(options.clientSecret);
  const timeoutMs = options.timeoutMs ?? 10_000;
  let metadata: Promise<oauth.AuthorizationServer> | null = null;

  const http = (call?: CallOptions) => {
    const signals = [AbortSignal.timeout(timeoutMs), ...(call?.signal ? [call.signal] : [])];
    return {
      signal: AbortSignal.any(signals),
      ...(options.fetch ? { [oauth.customFetch]: options.fetch } : {}),
    };
  };

  const client = (): oauth.Client => ({
    client_id: options.clientId,
    ...(options.clock ? { [oauth.clockSkew]: Math.round((options.clock() - Date.now()) / 1000) } : {}),
  });

  // Cached after the first success; a failed discovery is retried on the next call.
  function server(call?: CallOptions): Promise<oauth.AuthorizationServer> {
    if (metadata) return metadata;
    const pending = oauth.discoveryRequest(issuer, { algorithm: 'oidc', ...http(call) })
      .then(response => oauth.processDiscoveryResponse(issuer, response));
    metadata = pending;
    pending.catch(() => {
      if (metadata === pending) metadata = null;
    });
    return pending;
  }

  return {
    issuer: options.issuer,
    clientId: options.clientId,

    async authorizationUrl(request: AuthorizationRequest, call?: CallOptions): Promise<ProviderResult<string>> {
      if (request.codeChallengeMethod !== 'S256') return { kind: 'rejected', code: 'invalid_response' };
      let as: oauth.AuthorizationServer;
      try {
        as = await server(call);
      } catch {
        return { kind: 'unavailable' };
      }
      const methods = as.code_challenge_methods_supported;
      if (!as.authorization_endpoint || (methods !== undefined && !methods.includes('S256'))) return { kind: 'unavailable' };
      const url = new URL(as.authorization_endpoint);
      for (const [name, value] of Object.entries({
        client_id: options.clientId,
        redirect_uri: request.redirectUri,
        response_type: 'code',
        scope: SCOPE,
        state: request.state,
        nonce: request.nonce,
        code_challenge: request.codeChallenge,
        code_challenge_method: 'S256',
      })) url.searchParams.set(name, value);
      return { kind: 'ok', value: url.href };
    },

    async exchangeCode(exchange: CodeExchange, call?: CallOptions): Promise<ProviderResult<Readonly<Json>>> {
      let as: oauth.AuthorizationServer;
      try {
        as = await server(call);
      } catch {
        // Discovery says nothing about this callback; it is an outage, not a rejection.
        return { kind: 'unavailable' };
      }
      try {
        const c = client();
        const parameters = oauth.validateAuthResponse(as, c, new URL(exchange.callbackUrl), exchange.expectedState);
        const response = await oauth.authorizationCodeGrantRequest(
          as, c, clientAuth, parameters, exchange.redirectUri, exchange.codeVerifier, http(call),
        );
        if (response.status >= 500) return { kind: 'unavailable' };
        const tokens = await oauth.processAuthorizationCodeResponse(as, c, response, {
          expectedNonce: exchange.nonce, requireIdToken: true,
        });
        // The token came over TLS from the token endpoint, but the port promises a
        // signature check, so it does not rest on transport alone.
        await oauth.validateApplicationLevelSignature(as, response, http(call));
        const idToken = oauth.getValidatedIdTokenClaims(tokens);
        if (!idToken) return { kind: 'rejected', code: 'invalid_response' };
        const claims: Json = { ...idToken };
        if (claims.email === undefined || claims.email_verified === undefined) {
          if (!as.userinfo_endpoint) return { kind: 'ok', value: claims };
          const info = await oauth.processUserInfoResponse(
            as, c, idToken.sub, await oauth.userInfoRequest(as, c, tokens.access_token, http(call)),
          );
          // The library already refuses a different subject; this check does not depend on it.
          if (info.sub !== idToken.sub) return { kind: 'rejected', code: 'invalid_response' };
          // Both come from one source, so the verified flag describes this email.
          claims.email = info.email;
          claims.email_verified = info.email_verified;
        }
        return { kind: 'ok', value: claims };
      } catch (error) {
        return classify(error);
      }
    },
  };
}

/**
 * Protocol failures are the provider's answer and are final; anything else (DNS,
 * TLS, timeout, a 5xx body) is infrastructure and may succeed on a new sign-in.
 */
function classify(error: unknown): ProviderResult<never> {
  if (error instanceof oauth.AuthorizationResponseError) {
    return { kind: 'rejected', code: error.error === 'access_denied' ? 'denied' : 'invalid_response' };
  }
  if (error instanceof oauth.ResponseBodyError) {
    return error.status >= 500 ? { kind: 'unavailable' } : { kind: 'rejected', code: 'invalid_response' };
  }
  if (error instanceof oauth.OperationProcessingError || error instanceof oauth.WWWAuthenticateChallengeError) {
    return { kind: 'rejected', code: 'invalid_response' };
  }
  return { kind: 'unavailable' };
}
