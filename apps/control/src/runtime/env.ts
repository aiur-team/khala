// Runtime environment contract (KHA-131 U1). Validates that every required
// server variable from infra/netlify/env.schema.json is present before the
// gateway starts serving requests. Never logs or echoes a value — only key
// names ever appear in an error.

export type ServerEnv = Readonly<{
  publicAppOrigin: string;
  publicHomeserverOrigin: string;
  oidcIssuer: string;
  oidcClientId: string;
  oidcClientSecret: string;
  controlStateNamespace: string;
  matrixServerName: string;
  matrixRegistrationSharedSecret: string;
  matrixPasswordDerivationSecret: string;
  invitationHmacSecret: string;
}>;

export class EnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvironmentError';
  }
}

const REQUIRED_KEYS = [
  'PUBLIC_APP_ORIGIN',
  'PUBLIC_HOMESERVER_ORIGIN',
  'OIDC_ISSUER',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'CONTROL_STATE_NAMESPACE',
  'MATRIX_SERVER_NAME',
  'MATRIX_REGISTRATION_SHARED_SECRET',
  'MATRIX_PASSWORD_DERIVATION_SECRET',
  'INVITATION_HMAC_SECRET',
] as const;

/** Reads and validates the server-only environment contract. Throws (key names only, never values) if anything required is missing. */
export function readServerEnv(env: Readonly<Record<string, string | undefined>> = process.env): ServerEnv {
  const missing = REQUIRED_KEYS.filter(key => !env[key]);
  if (missing.length > 0) {
    throw new EnvironmentError(`missing required environment variable(s): ${missing.join(', ')}`);
  }
  return {
    publicAppOrigin: env.PUBLIC_APP_ORIGIN as string,
    publicHomeserverOrigin: env.PUBLIC_HOMESERVER_ORIGIN as string,
    oidcIssuer: env.OIDC_ISSUER as string,
    oidcClientId: env.OIDC_CLIENT_ID as string,
    oidcClientSecret: env.OIDC_CLIENT_SECRET as string,
    controlStateNamespace: env.CONTROL_STATE_NAMESPACE as string,
    matrixServerName: env.MATRIX_SERVER_NAME as string,
    matrixRegistrationSharedSecret: env.MATRIX_REGISTRATION_SHARED_SECRET as string,
    matrixPasswordDerivationSecret: env.MATRIX_PASSWORD_DERIVATION_SECRET as string,
    invitationHmacSecret: env.INVITATION_HMAC_SECRET as string,
  };
}
