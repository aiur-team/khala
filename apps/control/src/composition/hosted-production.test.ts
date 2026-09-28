import { describe, expect, it } from 'vitest';
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

function gateway(mode?: string, appOrigin = origin) {
  return createGateway({
    registrations: registerHostedProductionRoutes({ env: { ...env, PUBLIC_APP_ORIGIN: appOrigin, KHALA_ADMISSION_MODE: mode }, stores }),
    absentPrefixes: [], appOrigin,
  });
}

describe('generated hosted production composition', () => {
  it('registers channel closure regardless of the unresolved admission mode', () => {
    for (const mode of [undefined, 'explicit_browser_consent']) {
      const routes = registerHostedProductionRoutes({ env: { ...env, KHALA_ADMISSION_MODE: mode }, stores });
      expect(routes.filter(route => route.path === '/api/human/channel-closure')).toHaveLength(1);
    }
  });
  it('keeps bootstrap and device attestation unavailable on other origins or with an invalid explicit mode', async () => {
    for (const [mode, appOrigin] of [[undefined, 'https://preview.example.test'], ['', origin], ['automatic_same_computer', origin], ['explicit_browser_consant', origin]] as const) {
      const route = gateway(mode, appOrigin);
      const descriptor = await route(new Request(`${appOrigin}/api/agent/bootstrap/descriptor?link=${encodeURIComponent(`${appOrigin}/join/inv_abcdefgh`)}`));
      const consent = await route(new Request(`${appOrigin}/api/human/agent-bootstrap/authorize`));
      expect(descriptor.status).toBe(503);
      expect(consent.status).toBe(503);
      expect((await route(new Request(`${appOrigin}/api/agent/device-attestation/challenge`))).status).toBe(503);
      expect((await route(new Request(`${appOrigin}/api/human/owner-device-proof/challenge?room_id=!room:matrix.example.test&device_id=OWNER`))).status).toBe(503);
    }
  });

  it('binds the real descriptor and explicit browser consent routes only in the exact mode', async () => {
    const route = gateway('explicit_browser_consent');
    const descriptor = await route(new Request(`${origin}/api/agent/bootstrap/descriptor?link=${encodeURIComponent(`${origin}/join/inv_abcdefgh`)}`));
    expect(descriptor.status).toBe(200);
    expect(await descriptor.json()).toMatchObject({ invite: 'inv_abcdefgh', methods: ['loopback-browser-v1'] });

    const query = new URLSearchParams({
      invite: 'inv_abcdefgh', harness: 'codex', session_id: 'existing-session', generation: '1',
      device_id: 'device_1', jkt: 'A'.repeat(43), redirect_uri: 'http://127.0.0.1:44881/callback',
      code_challenge: 'B'.repeat(43), code_challenge_method: 'S256', state: 'state-1234567890',
    });
    const consent = await route(new Request(`${origin}/api/human/agent-bootstrap/authorize?${query}`));
    expect(consent.status).toBe(303); // signed-out browser goes through the real OIDC entry
    expect(consent.headers.get('location')).toContain('/api/human/auth/login');
    expect(consent.headers.get('cache-control')).toBe('no-store');
    const ownerProof = await route(new Request(`${origin}/api/human/owner-device-proof/challenge?room_id=!room:matrix.example.test&device_id=OWNER`));
    expect(ownerProof.status).toBe(401);
  });
  it('enables explicit browser consent on the opted-in production origin when Netlify cannot set the flag', async () => {
    const route = gateway();
    const descriptor = await route(new Request(`${origin}/api/agent/bootstrap/descriptor?link=${encodeURIComponent(`${origin}/join/inv_abcdefgh`)}`));
    expect(descriptor.status).toBe(200);
    const revocation = await route(new Request(`${origin}/api/human/revocation/targets?roomId=!room:matrix.example.test`));
    expect(revocation.status).toBe(401);
    const send = await route(new Request(`${origin}/api/human/room-send/inspect`, { method: 'POST', headers: { origin } }));
    expect(send.status).toBe(400);
  });
});
