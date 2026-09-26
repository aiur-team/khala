import { randomBytes } from 'node:crypto';
import {
  type ChannelListing, type ChannelListingPage, MAX_CHANNEL_LIST_PAGE_SIZE, decodeChannelListingPage,
} from '@khala/contracts/messaging/index';
import type { DiscoveryStore, DiscoveryTarget } from '../../store/discovery-store';

// In-memory listing snapshots for the internal service. The first page freezes
// the caller's eligible channels (title order, never activity) for five
// minutes, bound to the principal and session generation. Every page and every
// listing-reference resolution rechecks current eligibility and visibility; any
// change to a snapshotted channel makes the cursor `cursor_unavailable` rather
// than serving stale data. Snapshots and references do not survive a restart.

export const SNAPSHOT_TTL_MS = 300_000;
export const MAX_SNAPSHOT_ITEMS = 500;
export const LIST_REQUESTS_PER_WINDOW = 10;
export const LIST_WINDOW_MS = 60_000;
const MAX_SNAPSHOTS = 256;
const MAX_REFERENCES = 4_096;
export const UNTITLED_CHANNEL = 'Untitled channel';

export type ListingCaller = Readonly<{ principal: string; generation: number }>;

export type ListingResult =
  | Readonly<{ kind: 'listed'; page: ChannelListingPage }>
  | Readonly<{ kind: 'rejected'; code: 'rate_limited' | 'cursor_unavailable' }>
  | Readonly<{ kind: 'unavailable' }>;

type SnapshotItem = Readonly<{ channelId: string; visibilityEpoch: number; listing: ChannelListing }>;
type Snapshot = Readonly<{ caller: ListingCaller; expiresAt: number; items: readonly SnapshotItem[] }>;
type Cursor = Readonly<{ snapshot: Snapshot; offset: number }>;
type Reference = Readonly<{ caller: ListingCaller; channelId: string; visibilityEpoch: number; expiresAt: number }>;

export type InternalListing = Readonly<{
  list(caller: ListingCaller, cursor: string | null): ListingResult;
  /** Current, still-eligible channel for a reference issued to exactly this caller; never writes. */
  resolve(caller: ListingCaller, listingRef: string): DiscoveryTarget | 'unavailable';
}>;

const token = (prefix: string) => `${prefix}${randomBytes(24).toString('base64url')}`;
const sameCaller = (a: ListingCaller, b: ListingCaller) => a.principal === b.principal && a.generation === b.generation;

function prune<V extends { expiresAt: number }>(map: Map<string, V>, now: number, max: number): void {
  for (const [key, value] of map) if (value.expiresAt <= now || map.size > max) map.delete(key);
}

export function createInternalListing(deps: Readonly<{ store: DiscoveryStore; clock: () => number }>): InternalListing {
  const cursors = new Map<string, Cursor & { expiresAt: number }>();
  const references = new Map<string, Reference>();
  const budgets = new Map<string, number[]>();

  function withinBudget(caller: ListingCaller, now: number): boolean {
    const key = `${caller.principal}\0${caller.generation}`;
    const recent = (budgets.get(key) ?? []).filter(at => at > now - LIST_WINDOW_MS);
    if (recent.length >= LIST_REQUESTS_PER_WINDOW) {
      budgets.set(key, recent);
      return false;
    }
    recent.push(now);
    budgets.set(key, recent);
    return true;
  }

  /** Still eligible for this caller, with the snapshotted visibility. */
  function current(caller: ListingCaller, channelId: string, visibilityEpoch: number): DiscoveryTarget | 'changed' | 'unavailable' {
    const target = deps.store.target(channelId);
    if (target.kind === 'unavailable') return 'unavailable';
    if (target.kind === 'absent' || target.target.visibilityEpoch !== visibilityEpoch) return 'changed';
    const eligible = deps.store.eligible(channelId, caller.principal);
    if (eligible === 'unavailable') return 'unavailable';
    return eligible ? target.target : 'changed';
  }

  function page(snapshot: Snapshot, offset: number, now: number): ListingResult {
    const items = snapshot.items.slice(offset, offset + MAX_CHANNEL_LIST_PAGE_SIZE);
    for (const item of items) {
      const state = current(snapshot.caller, item.channelId, item.visibilityEpoch);
      if (state === 'unavailable') return { kind: 'unavailable' };
      if (state === 'changed') return { kind: 'rejected', code: 'cursor_unavailable' };
    }
    prune(references, now, MAX_REFERENCES);
    for (const item of items) {
      references.set(item.listing.listingRef, {
        caller: snapshot.caller, channelId: item.channelId, visibilityEpoch: item.visibilityEpoch, expiresAt: snapshot.expiresAt,
      });
    }
    let nextCursor: string | null = null;
    if (offset + items.length < snapshot.items.length) {
      prune(cursors, now, MAX_SNAPSHOTS);
      nextCursor = token('lcur_');
      cursors.set(nextCursor, { snapshot, offset: offset + items.length, expiresAt: snapshot.expiresAt });
    }
    const decoded = decodeChannelListingPage({ v: 1, items: items.map(item => item.listing), nextCursor });
    return decoded.ok ? { kind: 'listed', page: decoded.value } : { kind: 'unavailable' };
  }

  return {
    list(caller, cursor) {
      const now = deps.clock();
      if (!withinBudget(caller, now)) return { kind: 'rejected', code: 'rate_limited' };
      if (cursor !== null) {
        const found = cursors.get(cursor);
        if (!found || found.expiresAt <= now || !sameCaller(found.snapshot.caller, caller)) {
          return { kind: 'rejected', code: 'cursor_unavailable' };
        }
        cursors.delete(cursor);
        return page(found.snapshot, found.offset, now);
      }
      const eligible = deps.store.eligibleChannels(caller.principal);
      if (eligible.kind !== 'done') return { kind: 'unavailable' };
      const snapshot: Snapshot = {
        caller,
        expiresAt: now + SNAPSHOT_TTL_MS,
        items: eligible.channels.slice(0, MAX_SNAPSHOT_ITEMS).map(channel => ({
          channelId: channel.channelId,
          visibilityEpoch: channel.visibilityEpoch,
          listing: {
            v: 1,
            listingRef: token('lref_'),
            title: channel.title ?? UNTITLED_CHANNEL,
            visibility: channel.visibility,
            serviceKind: 'internal',
            requestState: 'not_requested',
          },
        })),
      };
      return page(snapshot, 0, now);
    },

    resolve(caller, listingRef) {
      const reference = references.get(listingRef);
      if (!reference || reference.expiresAt <= deps.clock() || !sameCaller(reference.caller, caller)) return 'unavailable';
      const state = current(caller, reference.channelId, reference.visibilityEpoch);
      return typeof state === 'object' ? state : 'unavailable';
    },
  };
}
