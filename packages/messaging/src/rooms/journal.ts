// Local operation journal. Intent is written here before any remote effect so a
// retry reuses the original operation identity and bytes. Records hold message
// bodies, so the journal is device-local storage supplied by composition, never
// the shared ControlStore.

import type { DeviceId, EventRef, MessageContent, OwnerId, ParticipantId, RoomId, RoomSummary, SendState } from '@khala/contracts/messaging/index';

/**
 * `in_flight` is written before the SDK call and stays when its result is lost,
 * so it doubles as "outcome unknown". `not_applied` is proof nothing was created.
 */
export type CreateRecord = Readonly<{
  type: 'create';
  ownerId: OwnerId;
  title: string | null;
  state: 'in_flight' | 'not_applied' | 'created';
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

export type JournalRead = Readonly<{ kind: 'absent' }> | Readonly<{ kind: 'record'; value: JournalRecord }> | Readonly<{ kind: 'unavailable' }>;

export type JournalClaim = Readonly<{ kind: 'claimed' }> | Readonly<{ kind: 'exists'; value: JournalRecord }> | Readonly<{ kind: 'unavailable' }>;

export interface RoomJournal {
  read(key: string): Promise<JournalRead>;
  /** Stores `value` only when `key` is absent; otherwise returns what is there. */
  claim(key: string, value: JournalRecord): Promise<JournalClaim>;
  /** Replaces the record at `key`. `unavailable` means it was not stored. */
  put(key: string, value: JournalRecord): Promise<Readonly<{ kind: 'stored' | 'unavailable' }>>;
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
  const records = new Map<string, JournalRecord>();
  return {
    async read(key) {
      const value = records.get(key);
      return value ? { kind: 'record', value: structuredClone(value) } : { kind: 'absent' };
    },
    async claim(key, value) {
      const existing = records.get(key);
      if (existing) return { kind: 'exists', value: structuredClone(existing) };
      records.set(key, structuredClone(value));
      return { kind: 'claimed' };
    },
    async put(key, value) {
      records.set(key, structuredClone(value));
      return { kind: 'stored' };
    },
  };
}
