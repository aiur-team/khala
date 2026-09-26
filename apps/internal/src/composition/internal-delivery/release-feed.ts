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

const RELEASE_ID_DOMAIN = 'khala.internal.release.v1';
/** The internal channel has no trust-policy versions; its releases are all version 0. */
const INTERNAL_POLICY_VERSION = 0;

export type PauseRead = boolean | 'unavailable';

export type InternalReleaseFeedInput = Readonly<{
  store: ChannelStore;
  listeningModes: Pick<SqliteListeningModeRepository, 'read'>;
  /** Whether the binding generation is paused. Absent means no pause source is composed. */
  paused?: (binding: SessionBinding) => PauseRead;
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

function release(binding: SessionBinding, event: StoredEvent, modeWakes: boolean): AgentRelease | null {
  const releaseId = internalReleaseId(binding, event.eventId);
  const ref = eventRef(event);
  const encoded = encodeReleasePayload({
    releaseId,
    bindingId: binding.bindingId as BindingId,
    generation: binding.generation,
    policyVersion: INTERNAL_POLICY_VERSION,
    items: [{ ref, content: event.content }],
  });
  if (!encoded.ok) return null;
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
  return {
    read({ binding, channelId, cursor, limit }): AgentReleaseRead {
      try {
        const paused = input.paused?.(binding) ?? false;
        if (paused === 'unavailable') return { kind: 'unavailable' };
        if (paused) return { kind: 'held', reason: 'paused' };
        const control = input.listeningModes.read({ bindingId: binding.bindingId, generation: binding.generation });
        if (control.kind === 'unavailable') return { kind: 'held', reason: 'mode_unavailable' };
        // `sync` is the default until the binding's mode is first set.
        const modeWakes = control.kind === 'absent' || control.control.requested !== 'async';
        const page = input.store.readSubscription({ channelId, binding, cursor, limit });
        if (page.kind === 'rejected') return { kind: 'rejected', code: page.code };
        if (page.kind !== 'page') return { kind: 'unavailable' };
        const releases: AgentRelease[] = [];
        for (const event of page.events) {
          const next = release(binding, event, modeWakes);
          // An event that cannot be encoded must not be skipped past silently.
          if (next === null) return { kind: 'unavailable' };
          releases.push(next);
        }
        return { kind: 'page', releases, nextCursor: page.nextCursor, caughtUp: page.caughtUp };
      } catch {
        return { kind: 'unavailable' };
      }
    },
  };
}
