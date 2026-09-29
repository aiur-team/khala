import type { OidcClient } from './provider';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function requireLoopbackOrigin(value: string | undefined, name: string): void {
  let origin: URL;
  try { origin = new URL(value ?? ''); }
  catch { throw new Error(`KHALA_LOCAL_AUTH requires a loopback ${name}`); }
  if (!['http:', 'https:'].includes(origin.protocol) || !LOOPBACK.has(origin.hostname) || origin.origin !== value) {
    throw new Error(`KHALA_LOCAL_AUTH requires a loopback ${name}`);
  }
}

/** An explicit local-only provider. The regular login binding, session store and CSRF checks still apply. */
export function localOidcEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  if (env.KHALA_LOCAL_AUTH !== 'enabled') return false;
  if (env.NODE_ENV !== 'development') throw new Error('KHALA_LOCAL_AUTH requires NODE_ENV=development');
  requireLoopbackOrigin(env.PUBLIC_APP_ORIGIN, 'PUBLIC_APP_ORIGIN');
  requireLoopbackOrigin(env.PUBLIC_HOMESERVER_ORIGIN, 'PUBLIC_HOMESERVER_ORIGIN');
  return true;
}

export function createLocalOidcClient(origin: string, email: string): OidcClient {
  if (!/^[^\s@]+@[^\s@]+$/u.test(email)) throw new Error('KHALA_LOCAL_AUTH_EMAIL must be an email address');
  return {
    issuer: 'https://local.khala.invalid',
    clientId: 'khala-local-development',
    async authorizationUrl(request) {
      const callback = new URL('/api/human/auth/callback', origin);
      callback.searchParams.set('state', request.state);
      callback.searchParams.set('code', 'local-development');
      return { kind: 'ok', value: callback.href };
    },
    async exchangeCode(exchange) {
      const callback = new URL(exchange.callbackUrl);
      if (callback.origin !== origin || callback.pathname !== '/api/human/auth/callback'
        || callback.searchParams.get('state') !== exchange.expectedState
        || callback.searchParams.get('code') !== 'local-development'
        || callback.searchParams.size !== 2) return { kind: 'rejected', code: 'invalid_response' };
      return { kind: 'ok', value: {
        iss: this.issuer, aud: this.clientId, sub: email, email,
        email_verified: true, nonce: exchange.nonce, exp: Math.floor(Date.now() / 1000) + 60,
      } };
    },
  };
}
