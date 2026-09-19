import { describe, expect, it } from 'vitest';
import { EnvironmentError, readServerEnv } from './env';

const complete = {
  PUBLIC_APP_ORIGIN: 'https://khala.aiur.team',
  PUBLIC_HOMESERVER_ORIGIN: 'https://matrix.example.test',
  OIDC_ISSUER: 'https://issuer.example',
  OIDC_CLIENT_ID: 'khala-web',
  OIDC_CLIENT_SECRET: 'shh-secret',
  CONTROL_STATE_NAMESPACE: 'khala-prod',
  MATRIX_SERVER_NAME: 'matrix.example.test',
  MATRIX_REGISTRATION_SHARED_SECRET: 'registration-secret',
  MATRIX_PASSWORD_DERIVATION_SECRET: 'password-secret',
  INVITATION_HMAC_SECRET: 'invitation-secret',
};

describe('readServerEnv', () => {
  it('returns the parsed contract when every required key is present', () => {
    expect(readServerEnv(complete)).toEqual({
      publicAppOrigin: 'https://khala.aiur.team',
      publicHomeserverOrigin: 'https://matrix.example.test',
      oidcIssuer: 'https://issuer.example',
      oidcClientId: 'khala-web',
      oidcClientSecret: 'shh-secret',
      controlStateNamespace: 'khala-prod',
      matrixServerName: 'matrix.example.test',
      matrixRegistrationSharedSecret: 'registration-secret',
      matrixPasswordDerivationSecret: 'password-secret',
      invitationHmacSecret: 'invitation-secret',
    });
  });

  it('fails closed when a required key is missing, naming only the key', () => {
    const incomplete = { ...complete, OIDC_CLIENT_SECRET: undefined };
    let error: unknown;
    try {
      readServerEnv(incomplete);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EnvironmentError);
    expect((error as Error).message).toContain('OIDC_CLIENT_SECRET');
    expect((error as Error).message).not.toContain('shh-secret');
  });

  it('never includes any variable\'s value in the thrown message, even for present keys', () => {
    const incomplete = { ...complete, CONTROL_STATE_NAMESPACE: undefined };
    let error: unknown;
    try {
      readServerEnv(incomplete);
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).not.toContain('https://khala.aiur.team');
    expect((error as Error).message).not.toContain('shh-secret');
  });

  it('reports every missing key at once, not just the first', () => {
    let error: unknown;
    try {
      readServerEnv({});
    } catch (caught) {
      error = caught;
    }
    const message = (error as Error).message;
    expect(message).toContain('PUBLIC_APP_ORIGIN');
    expect(message).toContain('OIDC_CLIENT_SECRET');
    expect(message).toContain('CONTROL_STATE_NAMESPACE');
  });
});
