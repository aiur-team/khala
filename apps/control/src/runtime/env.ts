// Runtime environment contract (KHA-131 U1). Validates that every required
// server variable from infra/netlify/env.schema.json is present before the
// gateway starts serving requests. Never logs or echoes a value — only key
// names ever appear in an error.

export type ServerEnv = Readonly<{
  publicAppOrigin: string;
  oidcClientSecret: string;
  controlStateNamespace: string;
}>;

export class EnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvironmentError';
  }
}

const REQUIRED_KEYS = ['PUBLIC_APP_ORIGIN', 'OIDC_CLIENT_SECRET', 'CONTROL_STATE_NAMESPACE'] as const;

/** Reads and validates the server-only environment contract. Throws (key names only, never values) if anything required is missing. */
export function readServerEnv(env: Readonly<Record<string, string | undefined>> = process.env): ServerEnv {
  const missing = REQUIRED_KEYS.filter(key => !env[key]);
  if (missing.length > 0) {
    throw new EnvironmentError(`missing required environment variable(s): ${missing.join(', ')}`);
  }
  return {
    publicAppOrigin: env.PUBLIC_APP_ORIGIN as string,
    oidcClientSecret: env.OIDC_CLIENT_SECRET as string,
    controlStateNamespace: env.CONTROL_STATE_NAMESPACE as string,
  };
}
