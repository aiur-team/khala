// Messaging account/device preparation without human setup. Accounts are keyed
// by a stable external ID so a lost create response reconciles to one account.
// Devices are created by the endpoint itself through Synapse JWT login, so the
// control plane never holds an endpoint's Matrix access token or crypto keys.
import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, exportSPKI, generateKeyPair, type CryptoKey } from 'jose';

export type AccountRole = 'human' | 'agent';

export interface AccountPort {
  lookup(externalId: string): Promise<string | undefined>;
  create(externalId: string, localpart: string, displayName: string): Promise<string>;
  roomHasMember?(roomId: string, userId: string): Promise<boolean>;
}

export const AUTH_PROVIDER = 'khala-oidc';

export function localpartFor(externalId: string, role: AccountRole): string {
  return `khala_${role[0]}_${createHash('sha256').update(externalId).digest('hex').slice(0, 24)}`;
}

// Resumable: lookup by stable external ID before every create. A retry after a
// lost response therefore finds the account instead of minting a second one.
export async function ensureAccount(port: AccountPort, externalId: string, role: AccountRole, displayName: string, attempts = 3): Promise<string> {
  let failure: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return (await port.lookup(externalId)) ?? (await port.create(externalId, localpartFor(externalId, role), displayName));
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

// Module-behaviour double only; it proves nothing about a provider.
export class MemoryAccounts implements AccountPort {
  readonly accounts = new Map<string, string>();
  readonly members = new Map<string, Set<string>>();
  loseNextCreateResponse = false;

  async lookup(externalId: string) {
    return this.accounts.get(externalId);
  }

  async create(externalId: string, localpart: string) {
    const userId = `@${localpart}:khala-test.invalid`;
    if ([...this.accounts.values()].includes(userId)) throw new Error('M_USER_IN_USE');
    this.accounts.set(externalId, userId);
    if (this.loseNextCreateResponse) {
      this.loseNextCreateResponse = false;
      throw new Error('response lost after commit');
    }
    return userId;
  }

  async roomHasMember(roomId: string, userId: string) {
    return this.members.get(roomId)?.has(userId) ?? false;
  }
}

class HttpFailure extends Error {
  readonly status: number;
  constructor(status: number, errcode?: string) {
    super(`HTTP ${status}${errcode ? ` ${errcode}` : ''}`);
    this.status = status;
  }
}

// Server-side Synapse admin route. The admin token is an infrastructure secret
// held by the provisioning function; it never reaches a browser or endpoint.
export class SynapseAccounts implements AccountPort {
  private readonly baseUrl: string;
  private readonly adminToken: string;
  private readonly serverName: string;
  private readonly transport: typeof fetch;

  constructor(baseUrl: string, adminToken: string, serverName: string, transport: typeof fetch = fetch) {
    this.baseUrl = baseUrl;
    this.adminToken = adminToken;
    this.serverName = serverName;
    this.transport = transport;
  }

  private async call(path: string, method = 'GET', body?: unknown): Promise<any> {
    const response = await this.transport(this.baseUrl + path, {
      method, headers: { authorization: `Bearer ${this.adminToken}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new HttpFailure(response.status, json.errcode);
    return json;
  }

  async lookup(externalId: string) {
    try {
      return (await this.call(`/_synapse/admin/v1/auth_providers/${AUTH_PROVIDER}/users/${encodeURIComponent(externalId)}`)).user_id as string;
    } catch (error) {
      if (error instanceof HttpFailure && error.status === 404) return undefined;
      throw error;
    }
  }

  async create(externalId: string, localpart: string, displayName: string) {
    const userId = `@${localpart}:${this.serverName}`;
    // PUT is create-or-update, so a racing duplicate converges on the same user.
    await this.call(`/_synapse/admin/v2/users/${encodeURIComponent(userId)}`, 'PUT', {
      displayname: displayName, admin: false, external_ids: [{ auth_provider: AUTH_PROVIDER, external_id: externalId }],
    });
    return userId;
  }

  async roomHasMember(roomId: string, userId: string) {
    const { members } = await this.call(`/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}/members`);
    return (members as string[]).includes(userId);
  }

  async countByExternalPrefix(localpartPrefix: string): Promise<number> {
    const { users } = await this.call(`/_synapse/admin/v2/users?name=${encodeURIComponent(localpartPrefix)}&guests=false&limit=100`);
    return (users as unknown[]).length;
  }
}

// Short-lived, audience-bound login assertions for Synapse `org.matrix.login.jwt`.
// Synapse holds only the public key. Each assertion names one user.
export class DeviceLoginIssuer {
  readonly audience = 'khala-synapse-login';
  readonly publicKeyPem: string;
  readonly issuer: string;
  private readonly key: CryptoKey;
  private readonly now: () => number;

  private constructor(key: CryptoKey, publicKeyPem: string, issuer: string, now: () => number) {
    this.key = key;
    this.publicKeyPem = publicKeyPem;
    this.issuer = issuer;
    this.now = now;
  }

  static async create(issuer: string, now: () => number = Date.now): Promise<DeviceLoginIssuer> {
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    return new DeviceLoginIssuer(privateKey, await exportSPKI(publicKey), issuer, now);
  }

  async issue(userId: string, ttlSeconds = 60): Promise<string> {
    const localpart = userId.slice(1, userId.indexOf(':'));
    const iat = Math.floor(this.now() / 1000);
    return new SignJWT({}).setProtectedHeader({ alg: 'ES256' }).setSubject(localpart).setIssuer(this.issuer).setAudience(this.audience)
      .setIssuedAt(iat).setExpirationTime(iat + ttlSeconds).setJti(randomBytes(16).toString('hex')).sign(this.key);
  }

  synapseJwtConfig() {
    return { enabled: true, secret: this.publicKeyPem, algorithm: 'ES256', subject_claim: 'sub', issuer: this.issuer, audiences: [this.audience] };
  }
}
