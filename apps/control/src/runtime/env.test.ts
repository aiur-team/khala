import { describe, expect, it } from 'vitest';
import { EnvironmentError, readHumanServerEnv, readServerEnv } from './env';

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
  it('returns only the gateway keys and needs no Matrix or OIDC-client settings', () => {
    const gatewayOnly = { PUBLIC_APP_ORIGIN: 'https://khala.aiur.team', OIDC_CLIENT_SECRET: 'shh-secret', CONTROL_STATE_NAMESPACE: 'khala-prod' };
    expect(readServerEnv(gatewayOnly)).toEqual({
      publicAppOrigin: 'https://khala.aiur.team',
      oidcClientSecret: 'shh-secret',
      controlStateNamespace: 'khala-prod',
    });
  });

  it('returns the full human contract when every human key is present', () => {
    expect(readHumanServerEnv(complete)).toEqual({
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

  it('refuses the human contract when a Matrix key is missing, naming only the key', () => {
    expect(() => readHumanServerEnv({ ...complete, MATRIX_SERVER_NAME: undefined })).toThrow(/MATRIX_SERVER_NAME/);
    expect(() => readHumanServerEnv({ ...complete, MATRIX_SERVER_NAME: undefined })).not.toThrow(/registration-secret/);
  });
});
