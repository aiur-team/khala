import { describe, expect, it, vi } from 'vitest';
import type { BlobsStoreLike } from '../../runtime/control-store';
import { createProductionHumanServiceLoader } from './production';

const env = {
  PUBLIC_APP_ORIGIN: 'https://khala.aiur.team',
  PUBLIC_HOMESERVER_ORIGIN: 'https://matrix.example.test',
  OIDC_ISSUER: 'https://issuer.example',
  OIDC_CLIENT_ID: 'khala-web',
  OIDC_CLIENT_SECRET: 'oidc-secret',
  CONTROL_STATE_NAMESPACE: 'khala-production',
  MATRIX_SERVER_NAME: 'matrix.example.test',
  MATRIX_REGISTRATION_SHARED_SECRET: 'registration-secret-with-more-than-32-bytes',
  MATRIX_PASSWORD_DERIVATION_SECRET: 'password-secret-with-more-than-32-bytes',
  INVITATION_HMAC_SECRET: 'invitation-secret-with-more-than-32-bytes',
};

function emptyStore(): BlobsStoreLike {
  return {
    getWithMetadata: vi.fn(async () => null),
    setJSON: vi.fn(async () => ({ modified: true, etag: '1' })),
  };
}

describe('createProductionHumanServiceLoader', () => {
  it('logs only a fixed callback stage when the production store cannot read the login', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const stores = () => ({
        getWithMetadata: async () => { throw new Error('secret-cookie-value'); },
        setJSON: async () => ({ modified: true, etag: '1' }),
      });
      const load = createProductionHumanServiceLoader({ env, stores });
      const request = new Request('https://khala.aiur.team/api/human/auth/callback?code=secret-code&state=secret-state', {
        headers: { cookie: `__Host-khala_login=${'a'.repeat(43)}` },
      });
      const services = await load(request);
      expect(await services!.auth.completeSignIn(request)).toEqual({ kind: 'unavailable', cookies: [] });
      expect(warn).toHaveBeenCalledExactlyOnceWith('Khala auth callback', '{"stage":"login_read"}');
    } finally {
      warn.mockRestore();
    }
  });

  it('constructs no SDK/store resources until a request executes', async () => {
    const stores = vi.fn((name: string) => {
      void name;
      return emptyStore();
    });
    const load = createProductionHumanServiceLoader({ env, stores });

    expect(stores).not.toHaveBeenCalled();
    const services = await load(new Request('https://khala.aiur.team/api/human/me'));

    expect(stores.mock.calls.map(([name]) => name)).toEqual([
      'khala-production-records',
      'khala-production-operations',
    ]);
    expect(services).toMatchObject({ auth: expect.any(Object), admission: expect.any(Object), messaging: expect.any(Object) });
    expect(await services!.auth.authenticateRequest(new Request('https://khala.aiur.team/api/human/me'))).toEqual({ kind: 'signed_out' });
  });
});
