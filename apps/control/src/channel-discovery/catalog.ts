// Lazy, owner-authoritative external channel catalog. A channel with no entry is
// `secret`; only an authenticated current owner upserts, tombstones, or edits
// the private allowlist. The store has no enumeration, so the whole catalog is
// one CAS-guarded record whose epoch changes on every mutation.

import { createHash } from 'node:crypto';
import {
  type AuthPrincipal,
  type AuthorizedChannelRef,
  type CallOptions,
  type ChannelPrivateEligibilityPort,
  type ChannelVisibility,
  type ControlStore,
  type JsonValue,
  type OperationResult,
  type OwnerId,
  type PrivateEligibilityMutation,
  type RoomId,
  type StableAgentPrincipal,
  decodeChannelListing,
  ok,
  rejected,
  unavailable,
} from '@khala/contracts/messaging/index';
import { guardStore, settleWrite } from '../auth/store';

export const CATALOG_KEY = 'channel-discovery:catalog:external';
export const MAX_CATALOG_ENTRIES = 2_000;
export const MAX_ALLOWLIST_PRINCIPALS = 50;
const MAX_CAS_ATTEMPTS = 4;

export type ChannelOwnerAuthority = Readonly<{
  /** Whether `ownerId` currently owns `roomId` and may change its discovery policy. */
  canManage(input: Readonly<{ ownerId: OwnerId; roomId: RoomId }>, options?: CallOptions): Promise<'allowed' | 'forbidden' | 'unavailable'>;
}>;

export type KnownPrincipal =
  | Readonly<{ kind: 'known'; agentOwnerId: OwnerId; currentGeneration: number }>
  | Readonly<{ kind: 'unknown' }>
  | Readonly<{ kind: 'unavailable' }>;

/**
 * Stable principals the owner already knows through their own sessions,
 * completed pairing, or prior approved access. Never a free-text directory.
 */
export type KnownPrincipalDirectory = Readonly<{
  inspect(input: Readonly<{ ownerId: OwnerId; principal: StableAgentPrincipal }>, options?: CallOptions): Promise<KnownPrincipal>;
}>;

export type AllowedPrincipal = Readonly<{ principal: string; agentOwnerId: string }>;

export type CatalogEntry = Readonly<{
  roomId: string;
  ownerId: string;
  visibility: ChannelVisibility;
  /** Null exactly when the entry is a `secret` tombstone. */
  title: string | null;
  allowlist: readonly AllowedPrincipal[];
  revision: number;
  lastOperation: string;
  lastFingerprint: string;
}>;

export type Catalog = Readonly<{ v: 1; epoch: number; entries: Readonly<Record<string, CatalogEntry>> }>;

export type CatalogRead =
  | Readonly<{ kind: 'catalog'; catalog: Catalog; revision: string | null }>
  | Readonly<{ kind: 'unavailable' }>;

export type DiscoveryRequesterContext = Readonly<{ ownerId: OwnerId; principal: StableAgentPrincipal }>;

export type PublicDiscovery = 'enabled' | 'disabled';

export type MutationRejection = 'forbidden' | 'stale_revision' | 'operation_mismatch';
export type SettingsRejection = MutationRejection | 'public_discovery_disabled';

export type VisibilitySettings = Readonly<{
  v: 1;
  operationId: string;
  roomId: RoomId;
  visibility: ChannelVisibility;
  /** Required for `public`/`private`; must be null for `secret`. */
  title: string | null;
  /** Null only when the channel has never been registered. */
  expectedRevision: string | null;
}>;

export type CatalogDeps = Readonly<{
  store: ControlStore;
  ownerAuthority: ChannelOwnerAuthority;
  principals: KnownPrincipalDirectory;
  publicDiscovery: PublicDiscovery;
}>;

const EMPTY: Catalog = { v: 1, epoch: 0, entries: {} };

function digest(purpose: string, value: string): string {
  return createHash('sha256').update(`khala.channel-discovery.${purpose}.v1\u0000${value}`).digest('base64url');
}

/** Opaque server-only channel key; never shown to agents. */
export function channelKey(roomId: RoomId): AuthorizedChannelRef {
  return digest('channel', roomId) as AuthorizedChannelRef;
}

/**
 * The single enumeration rule. `secret` and absent entries are never eligible,
 * public listing obeys the hosted kill switch, and private eligibility is the
 * same owner or an owner-managed stable principal from the requester's owner.
 */
export function isEligible(entry: CatalogEntry, requester: DiscoveryRequesterContext, publicDiscovery: PublicDiscovery): boolean {
  if (entry.visibility === 'secret' || entry.title === null) return false;
  if (entry.visibility === 'public') return publicDiscovery === 'enabled';
  return entry.ownerId === requester.ownerId
    || entry.allowlist.some(item => item.principal === requester.principal && item.agentOwnerId === requester.ownerId);
}

export async function readCatalog(store: ControlStore, options?: CallOptions): Promise<CatalogRead> {
  const read = await guardStore(store).read<JsonValue>(CATALOG_KEY, options);
  if (read.kind === 'unavailable') return read;
  if (read.kind === 'absent') return { kind: 'catalog', catalog: EMPTY, revision: null };
  const catalog = decodeCatalog(read.record.value);
  return catalog ? { kind: 'catalog', catalog, revision: read.record.revision } : { kind: 'unavailable' };
}

/** Normalizes an owner title exactly as the listing contract will project it. */
export function normalizeTitle(title: unknown): string | null {
  const decoded = decodeChannelListing({
    v: 1, listingRef: 'probe', title, visibility: 'public', serviceKind: 'external', requestState: 'not_requested',
  });
  return decoded.ok ? decoded.value.title : null;
}

type Change = Readonly<{
  roomId: RoomId;
  owner: AuthPrincipal;
  operationId: string;
  fingerprint: JsonValue;
  expectedRevision: string | null;
  apply(current: CatalogEntry | null): CatalogEntry | MutationRejection;
}>;

async function mutate(
  deps: CatalogDeps, change: Change, options?: CallOptions,
): Promise<OperationResult<Readonly<{ revision: string }>, MutationRejection>> {
  let authority: 'allowed' | 'forbidden' | 'unavailable';
  try {
    authority = await deps.ownerAuthority.canManage({ ownerId: change.owner.ownerId, roomId: change.roomId }, options);
  } catch {
    return unavailable();
  }
  if (authority === 'unavailable') return unavailable();
  if (authority !== 'allowed') return rejected('forbidden');

  const key = channelKey(change.roomId);
  const operation = digest('operation', `${change.owner.ownerId}\u0000${change.operationId}`);
  const fingerprint = digest('fingerprint', JSON.stringify(change.fingerprint));
  const store = guardStore(deps.store);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const read = await readCatalog(store, options);
    if (read.kind === 'unavailable') return unavailable();
    const current = read.catalog.entries[key] ?? null;
    if (current && current.lastOperation === operation) {
      return current.lastFingerprint === fingerprint ? ok({ revision: String(current.revision) }) : rejected('operation_mismatch');
    }
    if ((current ? String(current.revision) : null) !== change.expectedRevision) return rejected('stale_revision');
    const applied = change.apply(current);
    if (typeof applied === 'string') return rejected(applied);
    if (!current && Object.keys(read.catalog.entries).length >= MAX_CATALOG_ENTRIES) return unavailable();
    const next: CatalogEntry = {
      ...applied,
      roomId: change.roomId,
      ownerId: change.owner.ownerId,
      revision: (current?.revision ?? 0) + 1,
      lastOperation: operation,
      lastFingerprint: fingerprint,
    };
    const catalog: Catalog = { v: 1, epoch: read.catalog.epoch + 1, entries: { ...read.catalog.entries, [key]: next } };
    const written = await settleWrite<JsonValue>(store, {
      key: CATALOG_KEY,
      expectedRevision: read.revision,
      operationId: `channel-discovery.catalog.${operation}.${read.catalog.epoch + 1}`,
      next: { value: catalog as unknown as JsonValue, expiresAt: null },
    });
    if (written.kind === 'applied') return ok({ revision: String(next.revision) });
    if (written.kind === 'unavailable') return unavailable();
    // Another channel's mutation moved the shared record; re-read and recheck.
  }
  return unavailable();
}

/** Owner-only visibility/title change. `secret` leaves a title-free tombstone. */
export function setVisibility(
  deps: CatalogDeps, input: VisibilitySettings, owner: AuthPrincipal, options?: CallOptions,
): Promise<OperationResult<Readonly<{ revision: string }>, SettingsRejection>> {
  if (input.visibility === 'public' && deps.publicDiscovery !== 'enabled') {
    return Promise.resolve(rejected('public_discovery_disabled'));
  }
  return mutate(deps, {
    roomId: input.roomId,
    owner,
    operationId: input.operationId,
    fingerprint: { kind: 'visibility', roomId: input.roomId, visibility: input.visibility, title: input.title },
    expectedRevision: input.expectedRevision,
    apply: current => ({
      ...(current ?? { roomId: input.roomId, ownerId: owner.ownerId, revision: 0, lastOperation: '', lastFingerprint: '' }),
      visibility: input.visibility,
      title: input.visibility === 'secret' ? null : input.title,
      allowlist: current?.allowlist ?? [],
    }),
  }, options);
}

/**
 * Owner-only private allowlist administration, keyed by stable principal. A
 * rebind never edits this list; the credential proves the current generation
 * at use, and `allow` requires the generation the owner inspected.
 */
export function createPrivateEligibility(deps: CatalogDeps): ChannelPrivateEligibilityPort & Readonly<{
  allowRoom(input: RoomEligibilityMutation, owner: AuthPrincipal, options?: CallOptions): Promise<OperationResult<Readonly<{ revision: string }>, MutationRejection>>;
  revokeRoom(input: RoomEligibilityMutation, owner: AuthPrincipal, options?: CallOptions): Promise<OperationResult<Readonly<{ revision: string }>, MutationRejection>>;
}> {
  async function allowRoom(input: RoomEligibilityMutation, owner: AuthPrincipal, options?: CallOptions) {
    let known: KnownPrincipal;
    try {
      known = await deps.principals.inspect({ ownerId: owner.ownerId, principal: input.principal }, options);
    } catch {
      return unavailable();
    }
    if (known.kind === 'unavailable') return unavailable();
    if (known.kind === 'unknown') return rejected('forbidden');
    if (known.currentGeneration !== input.expectedSessionGeneration) return rejected('stale_revision');
    const item: AllowedPrincipal = { principal: input.principal, agentOwnerId: known.agentOwnerId };
    return mutate(deps, {
      roomId: input.roomId, owner, operationId: input.operationId, expectedRevision: input.expectedRevision,
      fingerprint: { kind: 'allow', roomId: input.roomId, ...item, generation: input.expectedSessionGeneration },
      apply(current) {
        if (!current) return 'stale_revision';
        const allowlist = current.allowlist.filter(existing => !sameAllowed(existing, item));
        if (allowlist.length >= MAX_ALLOWLIST_PRINCIPALS) return 'forbidden';
        return { ...current, allowlist: [...allowlist, item] };
      },
    }, options);
  }

  function revokeRoom(input: RoomEligibilityMutation, owner: AuthPrincipal, options?: CallOptions) {
    return mutate(deps, {
      roomId: input.roomId, owner, operationId: input.operationId, expectedRevision: input.expectedRevision,
      fingerprint: { kind: 'revoke', roomId: input.roomId, principal: input.principal },
      apply: current => current
        ? { ...current, allowlist: current.allowlist.filter(existing => existing.principal !== input.principal) }
        : 'stale_revision',
    }, options);
  }

  async function byRef(
    input: PrivateEligibilityMutation, owner: AuthPrincipal, run: typeof allowRoom, options?: CallOptions,
  ): Promise<OperationResult<null, MutationRejection>> {
    const read = await readCatalog(deps.store, options);
    if (read.kind === 'unavailable') return unavailable();
    const entry = read.catalog.entries[input.channelRef];
    if (!entry) return rejected('forbidden');
    const result = await run({ ...input, roomId: entry.roomId as RoomId }, owner, options);
    return result.kind === 'ok' ? ok(null) : result;
  }

  return {
    allowRoom,
    revokeRoom,
    allow: (input, owner, options) => byRef(input, owner, allowRoom, options),
    revoke: (input, owner, options) => byRef(input, owner, revokeRoom, options),
  };
}

export type RoomEligibilityMutation = Omit<PrivateEligibilityMutation, 'channelRef'> & Readonly<{ roomId: RoomId }>;

function sameAllowed(a: AllowedPrincipal, b: AllowedPrincipal): boolean {
  return a.principal === b.principal && a.agentOwnerId === b.agentOwnerId;
}

function decodeCatalog(value: JsonValue): Catalog | null {
  if (!isObject(value) || value.v !== 1 || !Number.isSafeInteger(value.epoch) || !isObject(value.entries)) return null;
  const entries: Record<string, CatalogEntry> = {};
  for (const [key, raw] of Object.entries(value.entries)) {
    const entry = decodeEntry(raw);
    if (!entry) return null;
    entries[key] = entry;
  }
  return { v: 1, epoch: value.epoch as number, entries };
}

function decodeEntry(raw: JsonValue): CatalogEntry | null {
  if (!isObject(raw)) return null;
  const { roomId, ownerId, visibility, title, allowlist, revision, lastOperation, lastFingerprint } = raw;
  if (typeof roomId !== 'string' || typeof ownerId !== 'string' || typeof lastOperation !== 'string' || typeof lastFingerprint !== 'string'
    || (visibility !== 'public' && visibility !== 'private' && visibility !== 'secret')
    || !Number.isSafeInteger(revision) || !Array.isArray(allowlist)) return null;
  if (visibility === 'secret' ? title !== null : typeof title !== 'string') return null;
  const items: AllowedPrincipal[] = [];
  for (const item of allowlist as readonly JsonValue[]) {
    if (!isObject(item) || typeof item.principal !== 'string' || typeof item.agentOwnerId !== 'string') return null;
    items.push({ principal: item.principal, agentOwnerId: item.agentOwnerId });
  }
  return {
    roomId, ownerId, visibility, title: title as string | null, allowlist: items,
    revision: revision as number, lastOperation, lastFingerprint,
  };
}

function isObject(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
