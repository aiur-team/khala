// Snapshot-cursor listing and side-effect-free listing-reference resolution.
// A first page freezes the requester's eligible channel keys in stable,
// activity-free order; later pages and references recheck the live catalog and
// collapse every stale, foreign, tampered, or ineligible case to one outcome.

import { createHash } from 'node:crypto';
import {
  type AuthorizedChannelRef,
  type CallOptions,
  type ChannelListQuery,
  type ChannelListing,
  type ChannelListingPage,
  type ControlStore,
  type DiscoveryRequester,
  type JsonValue,
  type OperationResult,
  type OwnerId,
  type RoomId,
  type TrustedClock,
  decodeChannelListingPage,
  ok,
  rejected,
  unavailable,
} from '@khala/contracts/messaging/index';
import { type Random, guardStore, randomToken, settleWrite } from '../auth/store';
import { type ChannelOwnerAuthority, type PublicDiscovery, isEligible, readCatalog } from './catalog';

export const SNAPSHOT_TTL_MS = 300_000;
export const MAX_SNAPSHOT_ITEMS = 500;
export const LIST_REQUESTS_PER_WINDOW = 10;
export const LIST_WINDOW_MS = 60_000;
const MAX_CAS_ATTEMPTS = 4;

export type ListingDeps = Readonly<{
  store: ControlStore;
  clock: TrustedClock;
  random: Random;
  ownerAuthority: ChannelOwnerAuthority;
  publicDiscovery: PublicDiscovery;
}>;

/** The authenticated discovery caller, as proven by the bootstrap credential. */
export type ListingCaller = Readonly<{ ownerId: OwnerId; requester: DiscoveryRequester }>;

export type ListRejection = 'rate_limited' | 'cursor_unavailable';

export type ListingResolution =
  | Readonly<{ kind: 'resolved'; channelRef: AuthorizedChannelRef }>
  | Readonly<{ kind: 'unavailable' }>;

type Binding = Readonly<{ ownerId: string; principal: string; generation: number; origin: string; jkt: string }>;
type Snapshot = Readonly<{ v: 1; epoch: number; binding: Binding; items: readonly Readonly<{ key: string; token: string }>[] }>;

const SNAPSHOT_ID = /^[A-Za-z0-9_-]{43}$/;
const CURSOR = /^dcs_([A-Za-z0-9_-]{43})\.(0|[1-9][0-9]{0,3})$/;
const LISTING_REF = /^dlr_([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{22})$/;

function digest(purpose: string, value: string): string {
  return createHash('sha256').update(`khala.channel-discovery.${purpose}.v1\u0000${value}`).digest('base64url');
}

const snapshotKey = (id: string) => `channel-discovery:snapshot:${digest('snapshot', id)}`;

function bindingOf(caller: ListingCaller): Binding {
  return {
    ownerId: caller.ownerId,
    principal: caller.requester.principal,
    generation: caller.requester.sessionGeneration,
    origin: caller.requester.origin,
    jkt: caller.requester.proofKey.thumbprint,
  };
}

function sameBinding(a: Binding, b: Binding): boolean {
  return a.ownerId === b.ownerId && a.principal === b.principal && a.generation === b.generation
    && a.origin === b.origin && a.jkt === b.jkt;
}

function requesterOf(caller: ListingCaller) {
  return { ownerId: caller.ownerId, principal: caller.requester.principal };
}

/** Fixed one-minute window per verified session generation. */
export async function consumeListBudget(deps: ListingDeps, caller: ListingCaller, options?: CallOptions): Promise<'allowed' | 'limited' | 'unavailable'> {
  const store = guardStore(deps.store);
  const now = deps.clock();
  const windowStart = now - (now % LIST_WINDOW_MS);
  const bucket = digest('list-rate', [caller.ownerId, caller.requester.principal, caller.requester.sessionGeneration, windowStart].join('\u0000'));
  const key = `channel-discovery:list-rate:${bucket}`;
  const expiresAt = new Date(windowStart + 2 * LIST_WINDOW_MS).toISOString();
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const read = await store.read<JsonValue>(key, options);
    if (read.kind === 'unavailable') return 'unavailable';
    const count = read.kind === 'record' && typeof read.record.value === 'number' ? read.record.value : 0;
    if (read.kind === 'record' && typeof read.record.value !== 'number') return 'unavailable';
    if (count >= LIST_REQUESTS_PER_WINDOW) return 'limited';
    const written = await settleWrite<JsonValue>(store, {
      key, expectedRevision: read.kind === 'record' ? read.record.revision : null,
      operationId: `channel-discovery.list-rate.${bucket}.${count + 1}`,
      next: { value: count + 1, expiresAt },
    });
    if (written.kind === 'applied') return 'allowed';
    if (written.kind === 'unavailable') return 'unavailable';
  }
  return 'unavailable';
}

/** One bounded page. `cursor_unavailable` covers every stale or foreign cursor. */
export async function listChannels(
  deps: ListingDeps, caller: ListingCaller, query: ChannelListQuery, options?: CallOptions,
): Promise<OperationResult<ChannelListingPage, ListRejection>> {
  const budget = await consumeListBudget(deps, caller, options);
  if (budget === 'unavailable') return unavailable();
  if (budget === 'limited') return rejected('rate_limited');
  const read = await readCatalog(deps.store, options);
  if (read.kind === 'unavailable') return unavailable();
  const requester = requesterOf(caller);

  let snapshotId: string;
  let snapshot: Snapshot;
  let offset: number;
  if (query.cursor === null) {
    const items = Object.entries(read.catalog.entries)
      .filter(([, entry]) => isEligible(entry, requester, deps.publicDiscovery))
      .sort(([leftKey, left], [rightKey, right]) => compare(left.title!, right.title!) || compare(leftKey, rightKey))
      .slice(0, MAX_SNAPSHOT_ITEMS)
      .map(([key]) => ({ key, token: randomToken(deps.random, 16) }));
    snapshotId = randomToken(deps.random, 32);
    snapshot = { v: 1, epoch: read.catalog.epoch, binding: bindingOf(caller), items };
    const written = await settleWrite<JsonValue>(guardStore(deps.store), {
      key: snapshotKey(snapshotId), expectedRevision: null,
      operationId: `channel-discovery.snapshot.${digest('snapshot', snapshotId)}`,
      next: { value: snapshot as unknown as JsonValue, expiresAt: new Date(deps.clock() + SNAPSHOT_TTL_MS).toISOString() },
    });
    if (written.kind !== 'applied') return unavailable();
    offset = 0;
  } else {
    const parsed = CURSOR.exec(query.cursor);
    if (!parsed) return rejected('cursor_unavailable');
    const held = await readSnapshot(deps.store, parsed[1]!, options);
    if (held === 'unavailable') return unavailable();
    offset = Number(parsed[2]);
    if (held === null || held.epoch !== read.catalog.epoch || !sameBinding(held.binding, bindingOf(caller))
      || offset >= held.items.length) return rejected('cursor_unavailable');
    snapshotId = parsed[1]!;
    snapshot = held;
  }

  const slice = snapshot.items.slice(offset, offset + query.limit);
  const items: ChannelListing[] = [];
  for (const item of slice) {
    const entry = read.catalog.entries[item.key];
    if (!entry || !isEligible(entry, requester, deps.publicDiscovery)) return rejected('cursor_unavailable');
    items.push({
      v: 1,
      listingRef: `dlr_${snapshotId}.${item.token}`,
      title: entry.title!,
      visibility: entry.visibility,
      serviceKind: 'external',
      requestState: 'not_requested',
    });
  }
  const nextOffset = offset + slice.length;
  const page = decodeChannelListingPage({
    v: 1, items, nextCursor: nextOffset < snapshot.items.length ? `dcs_${snapshotId}.${nextOffset}` : null,
  });
  return page.ok ? ok(page.value) : unavailable();
}

/**
 * Revalidates an opaque listing reference for the same authenticated caller
 * against current policy and channel ownership. Never writes.
 */
export async function resolveListingRef(
  deps: ListingDeps, caller: ListingCaller, listingRef: string, options?: CallOptions,
): Promise<ListingResolution> {
  const none = { kind: 'unavailable' } as const;
  const parsed = LISTING_REF.exec(listingRef);
  if (!parsed) return none;
  const snapshot = await readSnapshot(deps.store, parsed[1]!, options);
  if (snapshot === null || snapshot === 'unavailable' || !sameBinding(snapshot.binding, bindingOf(caller))) return none;
  const item = snapshot.items.find(candidate => candidate.token === parsed[2]);
  if (!item) return none;
  const read = await readCatalog(deps.store, options);
  if (read.kind === 'unavailable') return none;
  const entry = read.catalog.entries[item.key];
  if (!entry || !isEligible(entry, requesterOf(caller), deps.publicDiscovery)) return none;
  try {
    const authority = await deps.ownerAuthority.canManage({ ownerId: entry.ownerId as OwnerId, roomId: entry.roomId as RoomId }, options);
    return authority === 'allowed' ? { kind: 'resolved', channelRef: item.key as AuthorizedChannelRef } : none;
  } catch {
    return none;
  }
}

async function readSnapshot(store: ControlStore, id: string, options?: CallOptions): Promise<Snapshot | null | 'unavailable'> {
  if (!SNAPSHOT_ID.test(id)) return null;
  const read = await guardStore(store).read<JsonValue>(snapshotKey(id), options);
  if (read.kind === 'unavailable') return 'unavailable';
  if (read.kind === 'absent') return null;
  return decodeSnapshot(read.record.value);
}

function decodeSnapshot(value: JsonValue): Snapshot | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, JsonValue>;
  const binding = record.binding as Record<string, JsonValue> | null;
  if (record.v !== 1 || !Number.isSafeInteger(record.epoch) || !Array.isArray(record.items)
    || typeof binding !== 'object' || binding === null || Array.isArray(binding)) return null;
  const { ownerId, principal, generation, origin, jkt } = binding;
  if (typeof ownerId !== 'string' || typeof principal !== 'string' || !Number.isSafeInteger(generation)
    || typeof origin !== 'string' || typeof jkt !== 'string') return null;
  const items: { key: string; token: string }[] = [];
  for (const item of record.items as readonly JsonValue[]) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    const { key, token } = item as Record<string, JsonValue>;
    if (typeof key !== 'string' || typeof token !== 'string') return null;
    items.push({ key, token });
  }
  return { v: 1, epoch: record.epoch as number, binding: { ownerId, principal, generation: generation as number, origin, jkt }, items };
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
