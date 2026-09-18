// Human owner identity: an OIDC relying party (oauth4webapi) plus the stable
// issuer/subject -> owner mapping and the control plane's cookie sessions.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as oauth from 'oauth4webapi';

export type VerifiedPrincipal = { iss: string; sub: string; email: string | undefined; emailVerified: boolean };
export type PendingLogin = { state: string; nonce: string; codeVerifier: string };

export type RelyingPartyConfig = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  // Only disposable loopback providers may use plain HTTP.
  allowInsecureLoopback?: boolean;
};

export class OidcRelyingParty {
  private server?: oauth.AuthorizationServer;
  private readonly client: oauth.Client;
  private readonly options: { [oauth.allowInsecureRequests]?: boolean };
  private readonly config: RelyingPartyConfig;

  constructor(config: RelyingPartyConfig) {
    this.config = config;
    this.client = { client_id: config.clientId };
    const loopback = /^http:\/\/127\.0\.0\.1:\d+$/.test(config.issuer);
    if (!config.issuer.startsWith('https://') && !(config.allowInsecureLoopback && loopback)) throw new Error('issuer must use https');
    this.options = config.allowInsecureLoopback && loopback ? { [oauth.allowInsecureRequests]: true } : {};
  }

  private async discover(): Promise<oauth.AuthorizationServer> {
    if (!this.server) {
      const issuer = new URL(this.config.issuer);
      this.server = await oauth.processDiscoveryResponse(issuer, await oauth.discoveryRequest(issuer, this.options));
    }
    return this.server;
  }

  async start(): Promise<{ url: string; pending: PendingLogin }> {
    const server = await this.discover();
    const pending = { state: oauth.generateRandomState(), nonce: oauth.generateRandomNonce(), codeVerifier: oauth.generateRandomCodeVerifier() };
    const url = new URL(server.authorization_endpoint!);
    url.search = new URLSearchParams({
      client_id: this.config.clientId, redirect_uri: this.config.redirectUri, response_type: 'code', scope: 'openid email',
      state: pending.state, nonce: pending.nonce, code_challenge: await oauth.calculatePKCECodeChallenge(pending.codeVerifier), code_challenge_method: 'S256',
    }).toString();
    return { url: url.href, pending };
  }

  async finish(callback: URL, pending: PendingLogin): Promise<VerifiedPrincipal> {
    const server = await this.discover();
    const parameters = oauth.validateAuthResponse(server, this.client, callback, pending.state);
    const response = await oauth.authorizationCodeGrantRequest(server, this.client, oauth.ClientSecretBasic(this.config.clientSecret), parameters, this.config.redirectUri, pending.codeVerifier, this.options);
    const result = await oauth.processAuthorizationCodeResponse(server, this.client, response, { expectedNonce: pending.nonce, requireIdToken: true });
    const claims = oauth.getValidatedIdTokenClaims(result)!;
    // Email may be absent from the ID token; the userinfo endpoint is authoritative for it.
    const info = await oauth.processUserInfoResponse(server, this.client, claims.sub, await oauth.userInfoRequest(server, this.client, result.access_token, this.options));
    return { iss: claims.iss, sub: claims.sub, email: info.email, emailVerified: info.email_verified === true };
  }
}

export type Owner = { ownerId: string; email: string | undefined };

// Owner identity is (issuer, subject). Email is a mutable display attribute and
// never a lookup key, so an email change cannot move or split ownership.
export class OwnerDirectory {
  private readonly bySubject = new Map<string, Owner>();

  resolve(principal: VerifiedPrincipal): Owner {
    const key = JSON.stringify([principal.iss, principal.sub]);
    let owner = this.bySubject.get(key);
    if (!owner) {
      owner = { ownerId: `own_${randomBytes(12).toString('hex')}`, email: undefined };
      this.bySubject.set(key, owner);
    }
    owner.email = principal.emailVerified ? principal.email : owner.email;
    return { ...owner };
  }

  get(ownerId: string): Owner | undefined {
    for (const owner of this.bySubject.values()) if (owner.ownerId === ownerId) return { ...owner };
    return undefined;
  }

  get size(): number {
    return this.bySubject.size;
  }
}

export type HumanSession = { ownerId: string; csrf: string; expiresAt: number };

export class HumanSessions {
  private readonly sessions = new Map<string, HumanSession>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(now: () => number, ttlMs = 8 * 3600_000) {
    this.now = now;
    this.ttlMs = ttlMs;
  }

  create(ownerId: string): { sid: string; session: HumanSession } {
    const sid = randomBytes(32).toString('base64url');
    const session = { ownerId, csrf: randomBytes(16).toString('base64url'), expiresAt: this.now() + this.ttlMs };
    this.sessions.set(sid, session);
    return { sid, session };
  }

  lookup(sid: string | undefined): HumanSession | undefined {
    const session = sid ? this.sessions.get(sid) : undefined;
    if (!session || session.expiresAt <= this.now()) return undefined;
    return session;
  }

  // Cookie plus matching CSRF header: a bearer token alone never counts.
  authenticate(sid: string | undefined, csrf: string | undefined): HumanSession | undefined {
    const session = this.lookup(sid);
    if (!session || !csrf || csrf.length !== session.csrf.length) return undefined;
    return timingSafeEqual(Buffer.from(csrf), Buffer.from(session.csrf)) ? session : undefined;
  }
}
