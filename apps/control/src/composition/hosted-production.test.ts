import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlobsStoreLike } from '../runtime/control-store';
import { createGateway } from '../runtime/handler';
import { registerHostedProductionRoutes } from './hosted-production';

const origin = 'https://khala.aiur.team';
const env = {
  PUBLIC_APP_ORIGIN: origin,
  PUBLIC_HOMESERVER_ORIGIN: 'https://matrix.example.test',
  OIDC_ISSUER: 'https://issuer.example.test',
  OIDC_CLIENT_ID: 'khala-web', OIDC_CLIENT_SECRET: 'oidc-secret',
  CONTROL_STATE_NAMESPACE: 'khala-production', MATRIX_SERVER_NAME: 'matrix.example.test',
  MATRIX_REGISTRATION_SHARED_SECRET: 'registration-secret-with-more-than-32-bytes',
  MATRIX_PASSWORD_DERIVATION_SECRET: 'password-secret-with-more-than-32-bytes',
  INVITATION_HMAC_SECRET: 'invitation-secret-with-more-than-32-bytes',
};
const stores = (): BlobsStoreLike => ({
  getWithMetadata: async () => null, setJSON: async () => ({ modified: true, etag: '1' }),
});

function durableStores() {
  const namespaces = new Map<string, Map<string, { data: unknown; etag: string }>>();
  let revision = 0;
  const storeFor = (name: string): BlobsStoreLike => {
    let records = namespaces.get(name);
    if (!records) { records = new Map(); namespaces.set(name, records); }
    const backing = records;
    return {
      async getWithMetadata(key) { return backing.get(key) ?? null; },
      async setJSON(key, data, options) {
        const current = backing.get(key);
        if (options?.onlyIfNew && current) return { modified: false, etag: current.etag };
        if (options?.onlyIfMatch && current?.etag !== options.onlyIfMatch) return { modified: false, ...(current ? { etag: current.etag } : {}) };
        const etag = String(++revision);
        backing.set(key, { data: structuredClone(data), etag });
        return { modified: true, etag };
      },
    };
  };
  return { storeFor };
}

function gateway(mode?: string, appOrigin = origin) {
  return createGateway({
    registrations: registerHostedProductionRoutes({ env: { ...env, PUBLIC_APP_ORIGIN: appOrigin, KHALA_ADMISSION_MODE: mode }, stores }),
    absentPrefixes: [], appOrigin,
  });
}

const keptRoutes = [
  ['/api/human/auth/login', ['GET']],
  ['/api/human/auth/callback', ['GET']],
  ['/api/human/me', ['GET']],
  ['/api/human/auth/logout', ['POST']],
  ['/api/human/invitations/share', ['POST']],
  ['/api/human/invitations/inspect', ['GET']],
  ['/api/human/invitations/admit', ['POST']],
  ['/api/human/messaging/session', ['POST']],
  ['/api/human/messaging/participants', ['POST']],
  ['/api/human/channel-link/resolve', ['POST']],
  ['/api/human/channel-link/personal', ['POST']],
  ['/api/human/agents/rename', ['POST']],
  ['/api/agent/join', ['POST']],
  ['/api/agent/join/poll', ['GET']],
  ['/api/agent/join/ready', ['POST']],
  ['/api/human/agent-join', ['GET']],
  ['/api/human/agent-join/confirm', ['POST']],
  ['/api/human/agent-join/status', ['GET']],
  ['/api/human/profile', ['GET']],
  ['/api/human/profile/username', ['POST']],
];
const deletedPaths = [
  '/api/human/room-send/ready', '/api/human/agent-bootstrap/authorize',
  '/api/human/owner-mailbox/submit', '/api/human/owner-device-proof/challenge',
  '/api/human/revocation/targets', '/api/human/devices/replacement',
  '/api/human/pairing/request', '/api/human/channel-access/inbox',
  '/api/human/channel-discovery/settings', '/api/human/channel-discovery/authority/create-target',
  '/api/human/channel-closure', '/api/agent/status', '/api/agent/messaging/participants',
  '/api/agent/bootstrap/descriptor', '/api/agent/channel-link/request',
  '/api/agent/room-send/ready', '/api/agent/device-attestation/challenge', '/api/agent/owner-mailbox/poll',
  '/api/human/unknown', '/api/agent/unknown',
];

describe('generated hosted production composition', () => {
  beforeEach(() => {
    vi.stubEnv('KHALA_LOCAL_AUTH', '');
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  });
  afterEach(() => vi.unstubAllEnvs());
  it('registers exactly the M1 paths and methods', () => {
    const blobs = durableStores();
    expect(registerHostedProductionRoutes({ env, stores: blobs.storeFor }).map(({ path, methods }) => [path, methods]))
      .toEqual(keptRoutes);
  });

  it.each([undefined, 'explicit_browser_consent', 'bogus'])('ignores admission mode %s at production and preview origins', async mode => {
    for (const appOrigin of [origin, 'https://preview.example.test']) {
      const registrations = registerHostedProductionRoutes({
        env: { ...env, PUBLIC_APP_ORIGIN: appOrigin, KHALA_ADMISSION_MODE: mode }, stores,
      });
      expect(registrations.map(({ path, methods }) => [path, methods])).toEqual(keptRoutes);
      const handle = gateway(mode, appOrigin);
      for (const path of deletedPaths) {
        for (const method of ['GET', 'POST']) {
          const response = await handle(new Request(`${appOrigin}${path}`, {
            method, ...(method === 'POST' ? { headers: { origin: appOrigin, 'content-type': 'application/json' }, body: '{}' } : {}),
          }));
          expect(response.status, `${method} ${path}`).toBe(404);
          expect(await response.json()).toMatchObject({ code: 'not_found', requestId: expect.any(String) });
        }
      }
      expect((await handle(new Request(`${appOrigin}/api/human/me`))).status).toBe(401);
      expect((await handle(new Request(`${appOrigin}/api/human/profile`))).status).toBe(401);
      expect((await handle(new Request(`${appOrigin}/api/human/profile/username`, {
        method: 'POST', headers: { origin: appOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'Kevin' }),
      }))).status).toBe(401);
      expect((await handle(new Request(`${appOrigin}/api/health`))).status).toBe(200);
    }
  });
});
