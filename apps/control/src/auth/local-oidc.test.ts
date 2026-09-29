import { describe, expect, it } from 'vitest';
import { createLocalOidcClient, localOidcEnabled } from './local-oidc';

const local = { KHALA_LOCAL_AUTH: 'enabled', NODE_ENV: 'development', PUBLIC_APP_ORIGIN: 'http://localhost:8888', PUBLIC_HOMESERVER_ORIGIN: 'http://127.0.0.1:8008' };

describe('local OIDC gate', () => {
  it('opens only for explicit development with loopback app and homeserver origins', () => {
    expect(localOidcEnabled(local)).toBe(true);
    expect(localOidcEnabled({ ...local, PUBLIC_APP_ORIGIN: 'http://127.0.0.1:8888', PUBLIC_HOMESERVER_ORIGIN: 'http://localhost:8008' })).toBe(true);
    expect(localOidcEnabled({ ...local, KHALA_LOCAL_AUTH: undefined })).toBe(false);
    for (const env of [
      { ...local, NODE_ENV: 'production' },
      { ...local, PUBLIC_APP_ORIGIN: 'https://khala.aiur.team' },
      { ...local, PUBLIC_APP_ORIGIN: 'http://example.com' },
      { ...local, PUBLIC_HOMESERVER_ORIGIN: 'https://matrix.example.com' },
      { ...local, PUBLIC_HOMESERVER_ORIGIN: 'http://localhost:8008/path' },
    ]) expect(() => localOidcEnabled(env)).toThrow();
  });

  it('keeps a callback bound to the issued state and local code', async () => {
    const client = createLocalOidcClient(local.PUBLIC_APP_ORIGIN, 'owner@khala.local');
    const request = { redirectUri: `${local.PUBLIC_APP_ORIGIN}/api/human/auth/callback`, state: 'state-1', nonce: 'nonce-1', codeChallenge: 'challenge', codeChallengeMethod: 'S256' as const };
    const url = await client.authorizationUrl(request);
    expect(url.kind).toBe('ok');
    if (url.kind !== 'ok') return;
    const exchange = { callbackUrl: url.value, redirectUri: request.redirectUri, expectedState: request.state, nonce: request.nonce, codeVerifier: 'verifier' };
    expect((await client.exchangeCode(exchange)).kind).toBe('ok');
    expect((await client.exchangeCode({ ...exchange, expectedState: 'wrong' })).kind).toBe('rejected');
  });
});
