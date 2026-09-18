// Local operation journal. Intent is written here before any remote effect so a
// retry reuses the original operation identity and bytes. Records hold message
// bodies, so the journal is device-local storage supplied by composition, never
// the shared ControlStore. Several tabs may share it, so writes compare revisions.

import type { DeviceId, EventRef, MessageContent, OwnerId, ParticipantId, RoomId, RoomSummary, SendState } from '@khala/contracts/messaging/index';

/**
 * - `attempting`: an SDK create is outstanding until `leaseUntilMs`. Another
 *   caller must not reconcile or create while the lease is live.
 * - `unknown`: the create finished without a result; reconcile before retrying.
 * - `not_applied`: proof nothing was created.
 * - `created`: the room exists.
 */
export type CreateRecord = Readonly<{
  type: 'create';
  ownerId: OwnerId;
  title: string | null;
  state: 'attempting' | 'unknown' | 'not_applied' | 'created';
  leaseUntilMs: number | null;
  room: RoomSummary | null;
}>;

/** One frozen outgoing message: its transaction ID and bytes never change. */
export type SendItem = Readonly<{
  clientTxnId: string;
  content: MessageContent;
  contentDigest: string;
  state: SendState['state'];
  eventRef: EventRef | null;
}>;

/** Author and device are frozen with the intent, so a changed account or device never retargets it. */
export type SendAuthor = Readonly<{ ownerId: OwnerId; participantId: ParticipantId; deviceId: DeviceId }>;

export type SendRecord = Readonly<{ type: 'send'; roomId: RoomId; author: SendAuthor; item: SendItem }>;

/** An approved intro selection. Order and membership are fixed at `prepareIntro`. */
export type IntroRecord = Readonly<{ type: 'intro'; roomId: RoomId; author: SendAuthor; items: readonly SendItem[] }>;

export type JournalRecord = CreateRecord | SendRecord | IntroRecord;

export type JournalRead =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'record'; value: JournalRecord; revision: string }>
  | Readonly<{ kind: 'unavailable' }>;

export type JournalClaim =
  | Readonly<{ kind: 'claimed'; revision: string }>
  | Readonly<{ kind: 'exists'; value: JournalRecord; revision: string }>
  | Readonly<{ kind: 'unavailable' }>;

export type JournalWrite = Readonly<{ kind: 'stored'; revision: string }> | Readonly<{ kind: 'conflict' }> | Readonly<{ kind: 'unavailable' }>;

export interface RoomJournal {
  read(key: string): Promise<JournalRead>;
  /** Stores `value` only when `key` is absent; otherwise returns what is there. */
  claim(key: string, value: JournalRecord): Promise<JournalClaim>;
  /** Replaces the record only while its revision is still `expectedRevision`. */
  replace(key: string, expectedRevision: string, value: JournalRecord): Promise<JournalWrite>;
}

export const journalKey = {
  create: (operationId: string) => `room.create:${operationId}`,
  intro: (batchId: string) => `room.intro:${batchId}`,
  send: (clientTxnId: string) => `room.send:${clientTxnId}`,
};

/**
 * Process-memory journal. It is not durable across reloads, so it only proves
 * module behaviour; composition supplies persistent device-local storage.
 */
export function createMemoryRoomJournal(): RoomJournal {
  const records = new Map<string, { value: JournalRecord; revision: string }>();
  let sequence = 0;
  const store = (key: string, value: JournalRecord) => {
    const revision = String(++sequence);
    records.set(key, { value: structuredClone(value), revision });
    return revision;
  };
  return {
    async read(key) {
      const found = records.get(key);
      return found ? { kind: 'record', value: structuredClone(found.value), revision: found.revision } : { kind: 'absent' };
    },
    async claim(key, value) {
      const found = records.get(key);
      if (found) return { kind: 'exists', value: structuredClone(found.value), revision: found.revision };
      return { kind: 'claimed', revision: store(key, value) };
    },
    async replace(key, expectedRevision, value) {
      if (records.get(key)?.revision !== expectedRevision) return { kind: 'conflict' };
      return { kind: 'stored', revision: store(key, value) };
    },
  };
}
