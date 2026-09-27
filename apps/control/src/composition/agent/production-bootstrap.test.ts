import { describe, expect, it, vi } from 'vitest';
import type { BlobsStoreLike } from '../../runtime/control-store';
import { createGateway } from '../../runtime/handler';
import { registerHumanHandlers } from '../human/handlers';
import { registerAgentHandlers } from './handlers';
import { createProductionBootstrapRoutes, inviteFromShareLink } from './production-bootstrap';

const origin = 'https://khala.aiur.team';
const env = {
  PUBLIC_APP_ORIGIN: origin,
  PUBLIC_HOMESERVER_ORIGIN: 'https://matrix.example.test',
  OIDC_ISSUER: 'https://issuer.example.test',
  OIDC_CLIENT_ID: 'khala-web',
  OIDC_CLIENT_SECRET: 'oidc-secret',
  CONTROL_STATE_NAMESPACE: 'khala-production',
  MATRIX_SERVER_NAME: 'matrix.example.test',
  MATRIX_REGISTRATION_SHARED_SECRET: 'registration-secret-with-more-than-32-bytes',
  MATRIX_PASSWORD_DERIVATION_SECRET: 'password-secret-with-more-than-32-bytes',
  INVITATION_HMAC_SECRET: 'invitation-secret-with-more-than-32-bytes',
};

function emptyStore(): BlobsStoreLike {
  return { getWithMetadata: async () => null, setJSON: async () => ({ modified: true, etag: '1' }) };
}

describe('production bootstrap route composition', () => {
  it('accepts only the canonical share link form', () => {
    expect(inviteFromShareLink(new URL(`${origin}/join/inv_abcdefgh`), origin)).toBe('inv_abcdefgh');
    for (const candidate of [
      `${origin}/channels/inv_abcdefgh`, `${origin}/join/inv_abcdefgh?owner=other`,
      `${origin}/join/inv_abcdefgh/extra`, 'https://other.example/join/inv_abcdefgh',
    ]) expect(inviteFromShareLink(new URL(candidate), origin)).toBeNull();
  });

  it('reaches the real bootstrap descriptor through the generated gateway registration seam', async () => {
    const stores = vi.fn(() => emptyStore());
    const agents = {
      inspect: vi.fn(async () => ({ kind: 'unavailable' as const, retryable: true as const })),
      admit: vi.fn(async () => ({ kind: 'unavailable' as const, retryable: true as const })),
    };
    const policy = vi.fn(async () => 'deny' as const);
    const bootstrap = createProductionBootstrapRoutes({
      env, stores, agents, admissionPolicy: policy,
      agentDeviceSession: { issue: async () => null },
    });
    const gateway = createGateway({
      registrations: [
        ...registerHumanHandlers({ bootstrap: () => bootstrap.human }),
        ...registerAgentHandlers({
          authorize: async () => 'forbidden',
          status: { snapshot: async () => ({ generation: 0, agents: [] }) },
          bootstrap: () => bootstrap.agent,
        }),
      ],
      absentPrefixes: [],
      appOrigin: origin,
    });

    const link = `${origin}/join/inv_abcdefgh`;
    const response = await gateway(new Request(`${origin}/api/agent/bootstrap/descriptor?link=${encodeURIComponent(link)}`));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      v: 1, invite: 'inv_abcdefgh', methods: ['loopback-browser-v1'],
      authorize: `${origin}/api/human/agent-bootstrap/authorize`,
    });
    expect(stores).toHaveBeenCalledTimes(2);
    expect(agents.inspect).not.toHaveBeenCalled();
    expect(agents.admit).not.toHaveBeenCalled();
    expect(policy).not.toHaveBeenCalled();

    const invalid = await gateway(new Request(`${origin}/api/agent/bootstrap/descriptor?link=${encodeURIComponent(`${origin}/channels/inv_abcdefgh`)}`));
    expect(invalid.status).toBe(404);
  });
});
