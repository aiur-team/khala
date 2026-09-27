// The hosted deployment's public configuration: the two origins Netlify
// inlines per deploy context, and the Content-Security-Policy derived from
// them. main.tsx reads it at boot; vite.config.ts reads it at build time to
// emit `_headers`, so the browser gate and the CSP agree on one origin.

export type HostedEnvironment = Readonly<{
  PUBLIC_APP_ORIGIN?: string;
  PUBLIC_HOMESERVER_ORIGIN?: string;
}>;

export type HostedConfigKey = keyof HostedEnvironment;

export type HostedConfig =
  | Readonly<{ ok: true; appOrigin: string; homeserverOrigin: string }>
  | Readonly<{ ok: false; missing: readonly HostedConfigKey[] }>;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The canonical origin for `value`, or null unless it is exactly an HTTPS
 * origin (HTTP only on loopback). A path, query, credentials or trailing
 * garbage is rejected rather than trimmed, so nothing unexpected can reach a
 * CSP directive.
 */
export function parsePublicOrigin(value: string | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  if (!secure || url.origin !== value.replace(/\/$/u, '')) return null;
  return url.origin;
}

export function readHostedConfig(env: HostedEnvironment): HostedConfig {
  const appOrigin = parsePublicOrigin(env.PUBLIC_APP_ORIGIN);
  const homeserverOrigin = parsePublicOrigin(env.PUBLIC_HOMESERVER_ORIGIN);
  if (appOrigin && homeserverOrigin) return { ok: true, appOrigin, homeserverOrigin };
  const missing: HostedConfigKey[] = [];
  if (!appOrigin) missing.push('PUBLIC_APP_ORIGIN');
  if (!homeserverOrigin) missing.push('PUBLIC_HOMESERVER_ORIGIN');
  return { ok: false, missing };
}

/**
 * Matrix crypto runs as WASM in a worker. `connect-src` admits the app's own
 * origin plus exactly the configured homeserver; without one it stays
 * same-origin and the app renders its unavailable state instead of connecting.
 */
export function contentSecurityPolicy(homeserverOrigin: string | null): string {
  const connectSources = homeserverOrigin ? `'self' ${homeserverOrigin}` : `'self'`;
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    `connect-src ${connectSources}`,
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; ');
}

/**
 * The Netlify `_headers` file the hosted build publishes. Netlify's static
 * netlify.toml cannot interpolate a per-context variable, so the CSP is
 * rendered here from the build's own PUBLIC_HOMESERVER_ORIGIN. A value that is
 * set but malformed fails the build rather than widening or dropping the policy.
 */
export function renderNetlifyHeaders(homeserverOriginValue: string | undefined): string {
  const homeserverOrigin = parsePublicOrigin(homeserverOriginValue);
  if (homeserverOriginValue && !homeserverOrigin) {
    throw new Error('PUBLIC_HOMESERVER_ORIGIN must be an HTTPS origin such as https://matrix.example.com');
  }
  return `/*\n  Content-Security-Policy: ${contentSecurityPolicy(homeserverOrigin)}\n`;
}
