import { describe, expect, it, vi } from 'vitest';
import type { BlobsStoreLike } from '../../runtime/control-store';
import { createProductionHumanRuntimeLoader, createProductionHumanServiceLoader } from './production';

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
  it('logs only the HTTP status when a session store read fails', async () => {
    const output: string[] = [];
    const log = vi.spyOn(console, 'info').mockImplementation(value => { output.push(String(value)); });
    try {
      const runtime = createProductionHumanRuntimeLoader({
        env,
        stores: () => ({
          getWithMetadata: async () => { throw Object.assign(new Error('private session value'), { status: 403 }); },
          setJSON: async () => ({ modified: true, etag: '1' }),
        }),
      })();
      expect(await runtime.store.read('auth.session.v1.private')).toEqual({ kind: 'unavailable' });
      expect(output).toEqual(['{"component":"human","event":"runtime","stage":"session_read_error","httpStatus":403}']);
      expect(output.join(' ')).not.toContain('private session value');
    } finally {
      log.mockRestore();
    }
  });

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

  it('logs fixed auth and initialization stages without request or secret material', async () => {
    const output: string[] = [];
    const log = vi.spyOn(console, 'info').mockImplementation(value => { output.push(String(value)); });
    try {
      const load = createProductionHumanServiceLoader({ env, stores: () => emptyStore() });
      const request = new Request('https://khala.aiur.team/api/human/me', {
        headers: { cookie: '__Host-khala_session=private-cookie', 'x-nf-request-id': 'private-request-id' },
      });
      const services = await load(request);
      expect(await services!.auth.authenticateRequest(request)).toEqual({ kind: 'signed_out' });
      expect(output).toEqual(['{"component":"human","event":"authenticate","stage":"cookie_invalid"}']);

      const broken = createProductionHumanServiceLoader({ env: {} });
      await expect(broken(request)).rejects.toThrow('human runtime unavailable');
      expect(output[1]).toBe('{"component":"human","event":"runtime","stage":"initialize_failed"}');
      expect(output.join(' ')).not.toMatch(/private-cookie|private-request-id|oidc-secret|registration-secret/);
    } finally {
      log.mockRestore();
    }
  });
});
