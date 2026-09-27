import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, parsePublicOrigin, readHostedConfig, renderNetlifyHeaders } from './hosted-config';

describe('parsePublicOrigin', () => {
  it('accepts an HTTPS origin, with or without a trailing slash', () => {
    expect(parsePublicOrigin('https://matrix.example.com')).toBe('https://matrix.example.com');
    expect(parsePublicOrigin('https://matrix.example.com/')).toBe('https://matrix.example.com');
    expect(parsePublicOrigin('https://matrix.example.com:8448')).toBe('https://matrix.example.com:8448');
  });

  it('accepts plain HTTP only on loopback', () => {
    expect(parsePublicOrigin('http://localhost:8008')).toBe('http://localhost:8008');
    expect(parsePublicOrigin('http://matrix.example.com')).toBeNull();
  });

  it('rejects anything that is not exactly an origin', () => {
    for (const value of [
      undefined,
      '',
      'https:',
      'matrix.example.com',
      'https://matrix.example.com/_matrix',
      'https://matrix.example.com?x=1',
      'https://user:pass@matrix.example.com',
      "https://matrix.example.com; script-src 'unsafe-inline'",
      ' https://matrix.example.com',
    ]) {
      expect(parsePublicOrigin(value), String(value)).toBeNull();
    }
  });
});

describe('readHostedConfig', () => {
  it('is ready when both origins are valid', () => {
    expect(readHostedConfig({
      PUBLIC_APP_ORIGIN: 'https://khala.aiur.team',
      PUBLIC_HOMESERVER_ORIGIN: 'https://matrix.example.com/',
    })).toEqual({ ok: true, appOrigin: 'https://khala.aiur.team', homeserverOrigin: 'https://matrix.example.com' });
  });

  it('names every missing or malformed origin instead of throwing', () => {
    expect(readHostedConfig({ PUBLIC_APP_ORIGIN: 'https://khala.aiur.team' }))
      .toEqual({ ok: false, missing: ['PUBLIC_HOMESERVER_ORIGIN'] });
    expect(readHostedConfig({ PUBLIC_HOMESERVER_ORIGIN: 'not an origin' }))
      .toEqual({ ok: false, missing: ['PUBLIC_APP_ORIGIN', 'PUBLIC_HOMESERVER_ORIGIN'] });
  });
});

describe('contentSecurityPolicy', () => {
  it('admits exactly the configured homeserver, never every HTTPS origin', () => {
    const csp = contentSecurityPolicy('https://matrix.example.com');
    expect(csp).toContain("connect-src 'self' https://matrix.example.com;");
    expect(csp).not.toMatch(/connect-src[^;]*\bhttps:(?!\/\/)/u);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
  });

  it('stays same-origin when no homeserver is configured', () => {
    expect(contentSecurityPolicy(null)).toContain("connect-src 'self';");
  });
});

describe('renderNetlifyHeaders', () => {
  it('renders a catch-all _headers rule carrying the derived CSP', () => {
    expect(renderNetlifyHeaders('https://matrix.example.com')).toBe(
      `/*\n  Content-Security-Policy: ${contentSecurityPolicy('https://matrix.example.com')}\n`,
    );
  });

  it('keeps connect-src same-origin for a build without the variable', () => {
    expect(renderNetlifyHeaders(undefined)).toContain("connect-src 'self';");
  });

  it('fails the build on a set but malformed origin rather than widening the policy', () => {
    expect(() => renderNetlifyHeaders('https:')).toThrow(/PUBLIC_HOMESERVER_ORIGIN must be an HTTPS origin/);
  });
});
