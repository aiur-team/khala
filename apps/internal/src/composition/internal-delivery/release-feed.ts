// The internal server's release feed for one bound agent. Every channel event the
// binding's subscription covers, other than the agent's own, becomes one release
// for exactly that binding generation. The release ID and bytes are pure functions
// of (binding, generation, event), so a client that re-pulls after a crash gets
// the identical record back and its inbox deduplicates it by release ID.
//
// Listening mode decides only whether a release may wake the harness: `async`
// never does, and neither does an agent-authored event, because no local
// automatic-release gate bounds agent-to-agent loops yet. A pause holds the whole
// feed behind its cursor. A revoked or stale generation is refused by the store.

import { createHash } from 'node:crypto';
import type { BindingId, EventRef, ReleaseId, SessionBinding } from '@khala/contracts/delivery/index';
import { encodeReleasePayload } from '@khala/policy/release/codec';
import type { SqliteListeningModeRepository } from '../../listening-mode-store/sqlite';
import type { AgentRelease, AgentReleaseFeed, AgentReleaseRead } from '../../server/channel-server';
import type { ChannelStore, StoredEvent } from '../../store/channel-store';
import { decodeSubscriptionCursor, encodeSubscriptionCursor } from '../../store/cursors';

const RELEASE_ID_DOMAIN = 'khala.internal.release.v1';
/** The internal channel has no trust-policy versions; its releases are all version 0. */
const INTERNAL_POLICY_VERSION = 0;
/** The inbox's record limit. A release whose encoded payload exceeds it could never be enqueued. */
export const MAX_RELEASE_PAYLOAD_BYTES = 64 * 1024;
/**
 * Budget for one pull page's payload bytes. The client refuses a response over 4 MiB and the
 * payloads travel base64-encoded (4/3), so 2 MiB leaves room for that and per-release metadata.
 */
export const MAX_PAGE_PAYLOAD_BYTES = 2 * 1024 * 1024;
/** Per-release JSON overhead counted against the page budget on top of the payload. */
const RELEASE_OVERHEAD_BYTES = 1024;
/** The whole body of an oversized placeholder; the real body is never carried. */
export const OVERSIZED_PLACEHOLDER_BODY = 'oversized: message body withheld; read it from the channel timeline by event';

export type PauseRead = boolean | 'unavailable';

export type InternalReleaseFeedInput = Readonly<{
  store: ChannelStore;
  listeningModes: Pick<SqliteListeningModeRepository, 'read'>;
  /** Whether the binding generation is paused. Absent means no pause source is composed. */
  paused?: (binding: SessionBinding) => PauseRead;
  /** Encoded release payload bound; larger releases become placeholders. Defaults to the inbox limit. */
  maxPayloadBytes?: number;
  /** Page payload budget; a page always carries at least one release. Defaults to MAX_PAGE_PAYLOAD_BYTES. */
  maxPagePayloadBytes?: number;
}>;

/** Deterministic per binding generation and event, never random or time-derived. */
export function internalReleaseId(binding: Pick<SessionBinding, 'bindingId' | 'generation'>, eventId: string): ReleaseId {
  const digest = createHash('sha256')
    .update(JSON.stringify([RELEASE_ID_DOMAIN, binding.bindingId, binding.generation, eventId]))
    .digest('base64url');
  return `rel_${digest}` as ReleaseId;
}

function eventRef(event: StoredEvent): EventRef {
  return {
    v: 1,
    roomId: event.channelId as EventRef['roomId'],
    eventId: event.eventId as EventRef['eventId'],
    authorParticipantId: event.authorParticipantId as EventRef['authorParticipantId'],
    authorDeviceId: event.authorDeviceId as EventRef['authorDeviceId'],
    contentDigest: event.contentDigest,
  };
}

function release(
  binding: SessionBinding, event: StoredEvent, modeWakes: boolean, maxPayloadBytes: number,
): AgentRelease | null {
  const releaseId = internalReleaseId(binding, event.eventId);
  const ref = eventRef(event);
  const encode = (content: StoredEvent['content']) => encodeReleasePayload({
    releaseId,
    bindingId: binding.bindingId as BindingId,
    generation: binding.generation,
    policyVersion: INTERNAL_POLICY_VERSION,
    items: [{ ref, content }],
  });
  let encoded = encode(event.content);
  // Measured on the escaped bytes, not the body: control characters expand sixfold.
  if (encoded.ok && encoded.bytes.byteLength > maxPayloadBytes) {
    encoded = encode({ v: 1, kind: 'text', body: OVERSIZED_PLACEHOLDER_BODY });
  }
  if (!encoded.ok || encoded.bytes.byteLength > maxPayloadBytes) return null;
  return {
    releaseId,
    events: [ref],
    payload: encoded.bytes,
    payloadDigest: `sha256:${createHash('sha256').update(encoded.bytes).digest('hex')}`,
    releasedAt: event.receivedAt,
    wake: modeWakes && event.participant.kind === 'human',
  };
}

export function createInternalReleaseFeed(input: InternalReleaseFeedInput): AgentReleaseFeed {
  const maxPayloadBytes = input.maxPayloadBytes ?? MAX_RELEASE_PAYLOAD_BYTES;
  const maxPagePayloadBytes = input.maxPagePayloadBytes ?? MAX_PAGE_PAYLOAD_BYTES;
  return {
    read({ binding, channelId, cursor, limit }): AgentReleaseRead {
      try {
        const paused = input.paused?.(binding) ?? false;
        if (paused === 'unavailable') return { kind: 'unavailable' };
        if (paused) return { kind: 'held', reason: 'paused' };
        const control = input.listeningModes.read({ bindingId: binding.bindingId, generation: binding.generation });
        if (control.kind === 'unavailable') return { kind: 'held', reason: 'mode_unavailable' };
        // Wakes on every message unless the binding requested `async`; an absent or null request wakes too.
        const modeWakes = control.kind === 'absent' || control.control.requested !== 'async';
        const page = input.store.readSubscription({ channelId, binding, cursor, limit });
        if (page.kind === 'rejected') return { kind: 'rejected', code: page.code };
        if (page.kind !== 'page') return { kind: 'unavailable' };
        const releases: AgentRelease[] = [];
        let spent = 0;
        for (const [index, event] of page.events.entries()) {
          const next = release(binding, event, modeWakes, maxPayloadBytes);
          // An event that cannot be encoded must not be skipped past silently.
          if (next === null) return { kind: 'unavailable' };
          spent += next.payload.byteLength + RELEASE_OVERHEAD_BYTES;
          if (index > 0 && spent > maxPagePayloadBytes) {
            // End the page early so the response stays under the client's limit; the cursor
            // stops at the last included event and the rest arrives on the next pull.
            const decoded = decodeSubscriptionCursor(page.nextCursor);
            if (!decoded) return { kind: 'unavailable' };
            const nextCursor = encodeSubscriptionCursor({ ...decoded, lastCoveredSequence: page.events[index - 1]!.sequence });
            return { kind: 'page', releases, nextCursor, caughtUp: false };
          }
          releases.push(next);
        }
        return { kind: 'page', releases, nextCursor: page.nextCursor, caughtUp: page.caughtUp };
      } catch {
        return { kind: 'unavailable' };
      }
    },
  };
}
