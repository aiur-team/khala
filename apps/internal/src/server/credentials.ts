import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import type { DeviceId, OwnerId, ParticipantId, RoomId } from '@khala/contracts/messaging/index';

const CREDENTIAL_BYTES = 32;
const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type HumanAuthority = Readonly<{
  ownerId: OwnerId;
  participantId: ParticipantId;
  deviceId: DeviceId;
}>;

/** Caller-injected one-time browser credential for one selected channel. */
export type BootstrapCredential = Readonly<{
  credential: string;
  channelId: RoomId;
  /** Epoch milliseconds after which the credential is unusable. */
  expiresAt: number;
  human: HumanAuthority;
}>;

/** Caller-injected agent credential pinned to one exact persisted binding. */
export type BindingCredential = Readonly<{
  credential: string;
  binding: SessionBinding;
  channels: readonly RoomId[];
}>;

/** A durable discovery-only agent, resolved from its capability digest on every request. */
export type DiscoveryIdentity = Readonly<{
  principal: string;
  generation: number;
  /** RFC 7638 thumbprint of the separately held connector proof key. */
  proofThumbprint: string;
}>;

export type Principal =
  | Readonly<{ kind: 'human'; sessionKey: string; human: HumanAuthority }>
  | Readonly<{ kind: 'binding'; sessionKey: string; binding: SessionBinding; channels: ReadonlySet<RoomId> }>
  /** The launch's transport capability: may only ask for a discovery descriptor. */
  | Readonly<{ kind: 'transport'; sessionKey: string }>
  | Readonly<{ kind: 'discovery'; sessionKey: string; agent: DiscoveryIdentity }>;

export type IssuedSession = Readonly<{ cookie: string; requestSecret: string; channelId: RoomId }>;

export type ExchangeOutcome =
  | Readonly<{ ok: true; session: IssuedSession }>
  | Readonly<{ ok: false; reason: 'invalid' | 'session_limit' }>;

export class CredentialConfigError extends Error {
  constructor() {
    super('loopback server: invalid credential configuration');
    this.name = 'CredentialConfigError';
  }
}

/** Canonical unpadded base64url of exactly 32 bytes; anything else is malformed. */
export function isCanonicalCredential(value: unknown): value is string {
  if (typeof value !== 'string' || !CREDENTIAL_PATTERN.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.byteLength === CREDENTIAL_BYTES && bytes.toString('base64url') === value;
}

export function mintCredential(): string {
  return randomBytes(CREDENTIAL_BYTES).toString('base64url');
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

type Entry<T> = Readonly<{ digest: Buffer; value: T }>;

/**
 * Credentials are indexed only by SHA-256 digest; the fixed-length digest is then
 * compared with `timingSafeEqual` so no string comparison exits early on a secret.
 */
class DigestTable<T> {
  readonly #entries = new Map<string, Entry<T>>();

  get size(): number {
    return this.#entries.size;
  }

  add(credential: string, value: T): boolean {
    const key = digest(credential);
    const index = key.toString('hex');
    if (this.#entries.has(index)) return false;
    this.#entries.set(index, { digest: key, value });
    return true;
  }

  lookup(credential: string): Readonly<{ key: string; value: T }> | null {
    const key = digest(credential);
    const index = key.toString('hex');
    const entry = this.#entries.get(index);
    return entry && timingSafeEqual(entry.digest, key) ? { key: index, value: entry.value } : null;
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }
}

type BrowserSession = Readonly<{ human: HumanAuthority; requestSecret: Buffer }>;

export type CredentialAuthority = Readonly<{
  exchangeBootstrap(input: Readonly<{ credential: unknown; channelId: unknown }>): ExchangeOutcome;
  authenticateBearer(credential: string): Principal | null;
  /** Constant-time match against the launch's transport capability. */
  authenticateTransport(credential: string): Principal | null;
  authenticateSession(cookie: string, requestSecret: string): Principal | null;
  /**
   * Installs a binding activated while the server runs. A binding scope holds one live
   * capability: installing it again replaces the prior one, which stops working.
   */
  installBinding(record: BindingCredential): boolean;
  clear(): void;
}>;

export function createCredentialAuthority(input: Readonly<{
  bootstrap: readonly BootstrapCredential[];
  bindings: readonly BindingCredential[];
  transportCapability?: string;
  clock: () => number;
  maxSessions: number;
}>): CredentialAuthority {
  const bootstrap = new DigestTable<BootstrapCredential>();
  const bindings = new DigestTable<BindingCredential>();
  const sessions = new DigestTable<BrowserSession>();
  const transport = new DigestTable<true>();
  // Binding scope -> digest-table key of its one live capability.
  const bindingScopes = new Map<string, string>();
  const scopeOf = (record: BindingCredential) => JSON.stringify([record.binding.bindingId, record.binding.generation]);

  for (const record of input.bootstrap) {
    if (!isCanonicalCredential(record.credential) || !Number.isSafeInteger(record.expiresAt)
      || typeof record.channelId !== 'string' || record.channelId.length === 0
      || ![record.human.ownerId, record.human.participantId, record.human.deviceId].every(id => typeof id === 'string' && id.length > 0)
      || !bootstrap.add(record.credential, record)) {
      throw new CredentialConfigError();
    }
  }
  function validBinding(record: BindingCredential): boolean {
    return isCanonicalCredential(record.credential) && record.channels.length > 0
      && new Set(record.channels).size === record.channels.length
      && !bootstrap.lookup(record.credential) && !transport.lookup(record.credential) && !bindings.lookup(record.credential);
  }

  for (const record of input.bindings) {
    const scope = scopeOf(record);
    if (bindingScopes.has(scope) || !validBinding(record) || !bindings.add(record.credential, record)) {
      throw new CredentialConfigError();
    }
    bindingScopes.set(scope, bindings.lookup(record.credential)!.key);
  }
  if (input.transportCapability !== undefined) {
    if (!isCanonicalCredential(input.transportCapability) || bootstrap.lookup(input.transportCapability)
      || bindings.lookup(input.transportCapability) || !transport.add(input.transportCapability, true)) {
      throw new CredentialConfigError();
    }
  }

  return {
    exchangeBootstrap(request) {
      if (!isCanonicalCredential(request.credential) || typeof request.channelId !== 'string') return { ok: false, reason: 'invalid' };
      const found = bootstrap.lookup(request.credential);
      // Failed validation burns nothing; expiry and channel mismatch fail closed.
      if (!found || input.clock() >= found.value.expiresAt || found.value.channelId !== request.channelId) {
        return { ok: false, reason: 'invalid' };
      }
      if (sessions.size >= input.maxSessions) return { ok: false, reason: 'session_limit' };
      bootstrap.delete(found.key);
      const cookie = mintCredential();
      const requestSecret = mintCredential();
      sessions.add(cookie, { human: found.value.human, requestSecret: digest(requestSecret) });
      return { ok: true, session: { cookie, requestSecret, channelId: found.value.channelId } };
    },

    authenticateBearer(credential) {
      if (!isCanonicalCredential(credential)) return null;
      const found = bindings.lookup(credential);
      if (!found) return null;
      return {
        kind: 'binding',
        sessionKey: found.key,
        binding: found.value.binding,
        channels: new Set(found.value.channels),
      };
    },

    authenticateTransport(credential) {
      if (!isCanonicalCredential(credential)) return null;
      const found = transport.lookup(credential);
      return found ? { kind: 'transport', sessionKey: found.key } : null;
    },

    authenticateSession(cookie, requestSecret) {
      if (!isCanonicalCredential(cookie) || !isCanonicalCredential(requestSecret)) return null;
      const found = sessions.lookup(cookie);
      if (!found || !timingSafeEqual(found.value.requestSecret, digest(requestSecret))) return null;
      return { kind: 'human', sessionKey: found.key, human: found.value.human };
    },

    installBinding(record) {
      if (!validBinding(record) || !bindings.add(record.credential, record)) return false;
      const scope = scopeOf(record);
      const prior = bindingScopes.get(scope);
      if (prior !== undefined) bindings.delete(prior);
      bindingScopes.set(scope, bindings.lookup(record.credential)!.key);
      return true;
    },

    clear() {
      bindingScopes.clear();
      bootstrap.clear();
      bindings.clear();
      sessions.clear();
      transport.clear();
    },
  };
}
