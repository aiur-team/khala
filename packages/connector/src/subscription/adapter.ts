// The narrow transport/crypto SDK surface the subscription needs. G-SUBSTRATE is
// still open, so no SDK is imported here: the selected SDK's adapter implements
// this interface over its own sync and decryption APIs, and the connector
// runtime (KHA-133) injects it. Cursors are adapter-private opaque strings; this
// module never compares, orders or parses them.

import type { EventRef } from '@khala/contracts/delivery/index';
import type {
  CallOptions, DeviceId, Disposer, UnavailableEventRef, UnavailableReason,
} from '@khala/contracts/messaging/index';

/**
 * One event read from the durable source, in source order.
 *
 * - `decrypted`: the SDK verified the envelope and decrypted it. `verifiedDeviceId`
 *   is the sending device the crypto layer authenticated; the application still
 *   checks it against `ref.authorDeviceId` and the device's participant.
 *   `canonicalPayload` is the exact encoded content the `contentDigest` covers.
 * - `undecryptable`: the event exists but its plaintext is not available here.
 *   `missing_keys` may clear when room keys arrive later; the other reasons are
 *   final for this device.
 */
export type SourceEvent =
  | Readonly<{ kind: 'decrypted'; ref: EventRef; verifiedDeviceId: DeviceId; canonicalPayload: Uint8Array }>
  | Readonly<{ kind: 'undecryptable'; ref: UnavailableEventRef; reason: UnavailableReason }>;

/**
 * Result of reading after a cursor.
 *
 * - `page`: events after `cursor`, and the cursor that covers all of them.
 *   `caughtUp` means the source had nothing newer when the page was cut. Reading
 *   again from the same cursor must return the same events or a superset, so a
 *   page that was stored but not committed replays harmlessly.
 * - `gap`: the source can no longer replay from `cursor` (for example retention
 *   expired). Never papered over by skipping ahead.
 * - `unavailable`: transport outage; nothing was read. Retried with backoff.
 * - `rejected`: the source refused this device (`authority_lost`) or cannot
 *   provide a recoverable replay boundary at all (`unsupported`).
 */
export type SourceRead =
  | Readonly<{ kind: 'page'; events: readonly SourceEvent[]; nextCursor: string; caughtUp: boolean }>
  | Readonly<{ kind: 'gap' }>
  | Readonly<{ kind: 'unavailable' }>
  | Readonly<{ kind: 'rejected'; code: 'authority_lost' | 'unsupported' }>;

/** Outcome of rechecking this device's authority before (re)connecting. */
export type AuthorityCheck = 'ok' | 'revoked' | 'expired' | 'unavailable';

/**
 * Live reception callbacks. A hint carries no event, text, count or sender: it is
 * only a reason to read the durable source again. `lost` reports the live
 * connection dropped.
 */
export type SourceListener = Readonly<{ hint: () => void; lost: () => void }>;

/**
 * Asynchronous calls must settle promptly once `options.signal` aborts: the
 * subscription runs one connection at a time and waits for a superseded one.
 */
export interface SubscriptionSource {
  /** Rechecks membership and credentials; cached authority is never trusted across reconnects. */
  authorize(options?: CallOptions): Promise<AuthorityCheck>;
  /**
   * Attaches live reception. Called before replay, so events that arrive during
   * catch-up produce a hint instead of being lost between the two.
   */
  listen(listener: SourceListener): Disposer;
  /** `cursor` is `null` only for a stream with no committed cursor. */
  read(input: Readonly<{ cursor: string | null; limit: number }>, options?: CallOptions): Promise<SourceRead>;
}
