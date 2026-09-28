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
  /** Sanitized protocol diagnostic; never receives a provider body, URL, token or claim. */
  onFailure?: (diagnostic: OidcFailureDiagnostic) => void;
}>;

export type OidcFailureDiagnostic = Readonly<{
  stage: 'discovery' | 'callback' | 'token_request' | 'token_response' | 'signature' | 'claims' | 'userinfo';
  category: 'provider_rejection' | 'protocol_failure' | 'network_failure';
  status?: number;
  providerError?: 'invalid_client' | 'invalid_grant' | 'access_denied';
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

  const report = (diagnostic: OidcFailureDiagnostic) => {
    try { options.onFailure?.(diagnostic); } catch { /* Diagnostics must not change sign-in behavior. */ }
  };

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
        report({ stage: 'discovery', category: 'network_failure' });
        return { kind: 'unavailable' };
      }
      let stage: OidcFailureDiagnostic['stage'] = 'callback';
      try {
        const c = client();
        const parameters = oauth.validateAuthResponse(as, c, new URL(exchange.callbackUrl), exchange.expectedState);
        stage = 'token_request';
        const response = await oauth.authorizationCodeGrantRequest(
          as, c, clientAuth, parameters, exchange.redirectUri, exchange.codeVerifier, http(call),
        );
        if (response.status >= 500) {
          report({ stage: 'token_response', category: 'network_failure', status: response.status });
          return { kind: 'unavailable' };
        }
        stage = 'token_response';
        const tokens = await oauth.processAuthorizationCodeResponse(as, c, response, {
          expectedNonce: exchange.nonce, requireIdToken: true,
        });
        // The token came over TLS from the token endpoint, but the port promises a
        // signature check, so it does not rest on transport alone.
        stage = 'signature';
        await oauth.validateApplicationLevelSignature(as, response, http(call));
        stage = 'claims';
        const idToken = oauth.getValidatedIdTokenClaims(tokens);
        if (!idToken) {
          report({ stage: 'claims', category: 'protocol_failure' });
          return { kind: 'rejected', code: 'invalid_response' };
        }
        const claims: Json = { ...idToken };
        if (claims.email === undefined || claims.email_verified === undefined) {
          if (!as.userinfo_endpoint) return { kind: 'ok', value: claims };
          stage = 'userinfo';
          const info = await oauth.processUserInfoResponse(
            as, c, idToken.sub, await oauth.userInfoRequest(as, c, tokens.access_token, http(call)),
          );
          // The library already refuses a different subject; this check does not depend on it.
          if (info.sub !== idToken.sub) {
            report({ stage: 'userinfo', category: 'protocol_failure' });
            return { kind: 'rejected', code: 'invalid_response' };
          }
          // Both come from one source, so the verified flag describes this email.
          claims.email = info.email;
          claims.email_verified = info.email_verified;
        }
        return { kind: 'ok', value: claims };
      } catch (error) {
        report(diagnosticFor(stage, error));
        return classify(error);
      }
    },
  };
}

function diagnosticFor(stage: OidcFailureDiagnostic['stage'], error: unknown): OidcFailureDiagnostic {
  if (error instanceof oauth.ResponseBodyError) {
    const providerError = error.error === 'invalid_client' || error.error === 'invalid_grant' || error.error === 'access_denied'
      ? error.error : undefined;
    return { stage, category: 'provider_rejection', status: error.status, ...(providerError ? { providerError } : {}) };
  }
  if (error instanceof oauth.AuthorizationResponseError) {
    return { stage, category: 'provider_rejection', ...(error.error === 'access_denied' ? { providerError: 'access_denied' as const } : {}) };
  }
  if (error instanceof oauth.WWWAuthenticateChallengeError) {
    return { stage, category: 'provider_rejection', status: error.status };
  }
  if (error instanceof oauth.OperationProcessingError) {
    return { stage, category: 'protocol_failure' };
  }
  if (stage === 'callback') return { stage, category: 'protocol_failure' };
  return { stage, category: 'network_failure' };
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
