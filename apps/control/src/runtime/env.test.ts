import { describe, expect, it } from 'vitest';
import { EnvironmentError, readServerEnv } from './env';

const complete = {
  PUBLIC_APP_ORIGIN: 'https://khala.aiur.team',
  OIDC_CLIENT_SECRET: 'shh-secret',
  CONTROL_STATE_NAMESPACE: 'khala-prod',
};

describe('readServerEnv', () => {
  it('returns the parsed contract when every required key is present', () => {
    expect(readServerEnv(complete)).toEqual({
      publicAppOrigin: 'https://khala.aiur.team',
      oidcClientSecret: 'shh-secret',
      controlStateNamespace: 'khala-prod',
    });
  });

  it('fails closed when a required key is missing, naming only the key', () => {
    const incomplete = { PUBLIC_APP_ORIGIN: complete.PUBLIC_APP_ORIGIN, CONTROL_STATE_NAMESPACE: complete.CONTROL_STATE_NAMESPACE };
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
    const incomplete = { PUBLIC_APP_ORIGIN: complete.PUBLIC_APP_ORIGIN, OIDC_CLIENT_SECRET: complete.OIDC_CLIENT_SECRET };
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
