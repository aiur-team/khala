import type {
  CallOptions,
  ControlRecord,
  ControlStore,
  DeviceId,
  JsonValue,
  OwnerId,
  RoomId,
  RoomSummary,
} from '@khala/contracts/messaging/index';
import type { AdmissionHistory } from './policy';
import { type Digests, safeRead, writeAndResolve } from './internal';

export type AdmissionBinding = Readonly<{
  inviteRefDigest: string;
  inviteRevision: string;
  policyRevision: 1;
  roomId: RoomId;
  ownerId: OwnerId;
  deviceId: DeviceId;
  history: AdmissionHistory;
}>;

export type AdmissionJournalRecord = AdmissionBinding & Readonly<{
  v: 1;
  state: 'admitting' | 'outcome_unknown' | 'joined';
  room: RoomSummary | null;
}>;

export type JournalEntry = Readonly<{ record: AdmissionJournalRecord; revision: string }>;

export function createAdmissionJournal(store: ControlStore, digests: Digests) {
  const keyFor = (operationId: string) => `invitations.admission.${digests.operation(operationId)}`;

  async function read(operationId: string, options?: CallOptions): Promise<JournalEntry | 'absent' | 'unavailable'> {
    const result = await safeRead<AdmissionJournalRecord>(store, keyFor(operationId), options);
    if (result.kind !== 'record') return result.kind;
    const decoded = readJournalRecord(result.record.value);
    return decoded ? { record: decoded, revision: result.record.revision } : 'unavailable';
  }

  async function claim(operationId: string, binding: AdmissionBinding, options?: CallOptions): Promise<JournalEntry | 'operation_mismatch' | 'unavailable' | 'outcome_unknown'> {
    // The caller has just observed this key absent. Optimistically create it;
    // a concurrent winner is decoded from the CAS conflict below.
    const value: AdmissionJournalRecord = { v: 1, ...binding, state: 'admitting', room: null };
    const result = await writeAndResolve(store, {
      key: keyFor(operationId),
      expectedRevision: null,
      operationId: `invitation.admission.claim.${digests.operation(operationId)}`,
      next: { value, expiresAt: null },
    }, options);
    if (result.kind === 'applied') return entryFrom(result.record);
    if (result.kind === 'conflict' && result.current) {
      const current = readJournalRecord(result.current.value);
      return current && sameBinding(current, binding) ? entryFrom(result.current) : 'operation_mismatch';
    }
    if (result.kind === 'operation_mismatch') return 'operation_mismatch';
    return result.kind === 'outcome_unknown' ? 'outcome_unknown' : 'unavailable';
  }

  async function setState(
    operationId: string,
    entry: JournalEntry,
    state: 'outcome_unknown' | 'joined',
    room: RoomSummary | null,
    options?: CallOptions,
  ): Promise<JournalEntry | 'unavailable' | 'outcome_unknown'> {
    const value: AdmissionJournalRecord = { ...entry.record, state, room };
    if (entry.record.state === state && sameRoom(entry.record.room, room)) return entry;
    const result = await writeAndResolve(store, {
      key: keyFor(operationId),
      expectedRevision: entry.revision,
      operationId: `invitation.admission.${state}.${digests.operation(operationId)}`,
      next: { value, expiresAt: null },
    }, options);
    if (result.kind === 'applied') return entryFrom(result.record);
    if (result.kind === 'conflict' && result.current) {
      const current = readJournalRecord(result.current.value);
      if (current && sameBinding(current, entry.record) && current.state === state && sameRoom(current.room, room)) return entryFrom(result.current);
    }
    return result.kind === 'outcome_unknown' ? 'outcome_unknown' : 'unavailable';
  }

  return { read, claim, setState };
}

function entryFrom(record: ControlRecord<AdmissionJournalRecord>): JournalEntry {
  return { record: record.value, revision: record.revision };
}

function sameBinding(a: AdmissionBinding, b: AdmissionBinding): boolean {
  return a.inviteRefDigest === b.inviteRefDigest && a.inviteRevision === b.inviteRevision && a.policyRevision === b.policyRevision
    && a.roomId === b.roomId && a.ownerId === b.ownerId && a.deviceId === b.deviceId && a.history === b.history;
}

function readJournalRecord(value: JsonValue): AdmissionJournalRecord | null {
  if (!object(value)) return null;
  const { v, inviteRefDigest, inviteRevision, policyRevision, roomId, ownerId, deviceId, history, state, room } = value;
  if (v !== 1 || !text(inviteRefDigest) || !text(inviteRevision) || policyRevision !== 1 || !text(roomId) || !text(ownerId) || !text(deviceId)) return null;
  if ((history !== 'none' && history !== 'full') || (state !== 'admitting' && state !== 'outcome_unknown' && state !== 'joined')) return null;
  if (room === undefined) return null;
  const decodedRoom = room === null ? null : readRoom(room);
  if (room !== null && decodedRoom === null) return null;
  if (state === 'joined' && decodedRoom === null) return null;
  return {
    v: 1,
    inviteRefDigest,
    inviteRevision,
    policyRevision: 1,
    roomId: roomId as RoomId,
    ownerId: ownerId as OwnerId,
    deviceId: deviceId as DeviceId,
    history,
    state,
    room: decodedRoom,
  };
}

function sameRoom(a: RoomSummary | null, b: RoomSummary | null): boolean {
  return a === b || (a !== null && b !== null && a.roomId === b.roomId && a.title === b.title
    && a.membership === b.membership && a.revision === b.revision);
}

function readRoom(value: JsonValue): RoomSummary | null {
  if (!object(value) || !text(value.roomId) || (value.title !== null && typeof value.title !== 'string')
    || value.membership !== 'joined' || !text(value.revision)) return null;
  return { roomId: value.roomId as RoomSummary['roomId'], title: value.title as string | null, membership: 'joined', revision: value.revision };
}

function object(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: JsonValue | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}
