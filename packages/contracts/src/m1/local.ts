import { type Decoded, array, decodeWith, displayText, elementPath, fail, identifier, literal, nullable, object, safeInteger, text, utcTimestamp, utf8Length, version } from '../messaging/decode';
import { type Harness, M1_LABEL_MAX_BYTES, readChannelLink, readHarness, readHttpUrl, readMatrixUserId, readRoomId } from './agent-join';
import { type HumanColorId, readHumanColorId } from './colors';
import { readHumanInitials } from './initials';
import { LISTENING_MODES } from './listening-mode';
import { checkName } from './names';

export const LOCAL_SERVER_NAME = 'local' as const;
export const LOCAL_OWNER_USER_ID = '@khala_owner:local' as const;
export const LOCAL_DEFAULT_PORT = 47830;
export const LOCAL_LINK_TTL_MS = 600_000;
export const LOCAL_LONG_POLL_MAX_S = 25;
export const LOCAL_IDLE_EXIT_MS = 600_000;
export const LOCAL_TOKEN_BYTES = 32;
export const LOCAL_CHANNEL_NAME_MAX_CHARS = 64;
export const LOCAL_BODY_MAX_CHARS = 8000;
export const LOCAL_CONTENT_MAX_BYTES = 32_768;
export const LOCAL_EVENTS_PAGE_MAX = 200;
export const LOCAL_HISTORY_LIMIT_MAX = 100;
export const LOCAL_MEMBERS_MAX = 100;
export const LOCAL_AGENT_DEVICE_PREFIX = 'KH_LOCAL_' as const;

/** RFC 4648 URL-safe alphabet, without padding. */
export function base64url(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = bytes[i]! << 16 | (bytes[i + 1] ?? 0) << 8 | (bytes[i + 2] ?? 0);
    result += alphabet[n >> 18 & 63]! + alphabet[n >> 12 & 63]!;
    if (i + 1 < bytes.length) result += alphabet[n >> 6 & 63]!;
    if (i + 2 < bytes.length) result += alphabet[n & 63]!;
  }
  return result;
}
export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
function exact(bytes: Uint8Array, n: number): Uint8Array {
  if (bytes.length !== n) throw new RangeError('random_length');
  return bytes;
}
export const newLocalRoomId = (random16: Uint8Array): string => `!${base64url(exact(random16, 16))}:local`;
export const newLocalAgentUserId = (random4: Uint8Array): string => `@agent-${hex(exact(random4, 4))}:local`;
export const newLocalEventId = (random16: Uint8Array): string => `$${base64url(exact(random16, 16))}`;
export const isLocalRoomId = (value: string): boolean => /^![A-Za-z0-9_-]{22}:local$/u.test(value);
export const isLocalAgentUserId = (value: string): boolean => /^@agent-[0-9a-f]{8}:local$/u.test(value);
export const localAgentDeviceId = (userId: string): string => {
  if (!isLocalAgentUserId(userId)) throw new RangeError('not_local_agent');
  return `${LOCAL_AGENT_DEVICE_PREFIX}${userId.slice(7, 15)}`;
};
export const isLocalUserId = (value: string): boolean => value === LOCAL_OWNER_USER_ID || isLocalAgentUserId(value);
export const isLocalEventId = (value: string): boolean => /^\$[A-Za-z0-9_-]{22}$/u.test(value);
export const isLocalTxnId = (value: string): boolean => /^[A-Za-z0-9._-]{1,64}$/u.test(value);
export const localRoomKey = (roomId: string): string => {
  if (!isLocalRoomId(roomId)) throw new RangeError('not_local_room');
  return roomId.slice(1, -':local'.length);
};
export const localRoomPath = (roomId: string, tail: string): string => `/api/local/rooms/${encodeURIComponent(roomId)}/${tail}`;

export type LocalEventType = 'm.room.create' | 'm.room.name' | 'm.room.member' | 'm.room.message'
  | 'com.khala.event.v1' | 'com.khala.listening_mode.v1';

export type LocalEvent = {
  seq: number;                 // 1-based, strictly increasing per channel, assigned by the helper
  eventId: string;             // "$<22 base64url>"
  roomId: string;              // "!<22 base64url>:local"
  type: LocalEventType;
  sender: string;              // LOCAL_OWNER_USER_ID or "@agent-<8 hex>:local"
  ts: number;                  // helper clock, ms since epoch
  txnId?: string;              // present when the sender supplied one; (sender, txnId) is unique per channel
  content: Record<string, unknown>;
  previousContent?: LocalMemberContent; // helper-derived preceding membership, independent of roster fetch timing
};

// content by type
export type LocalCreateContent = { name: string; createdBy: string; operationId?: string };                       // m.room.create (seq 1)
export type LocalNameContent = { name: string };                                            // m.room.name
export type LocalMemberContent = {                                                          // m.room.member
  user: string; membership: 'invite' | 'join' | 'leave';
  displayname: string; kind: 'human' | 'agent';
  harness?: Harness; invitedBy?: string;
  'com.khala.listening_mode'?: 'steer' | 'sync' | 'async';
};
// m.room.message content: { msgtype: 'm.text', body: string }                 (body 1..8000 chars, as khala_send)
// com.khala.event.v1 content: ChannelEventContent from '@khala/contracts/m1/channel-event' (encoded by encodeChannelEvent)
// com.khala.listening_mode.v1 content: ListeningModeCommandContent from '@khala/contracts/m1/listening-mode' ({v:1, agent, mode}); sender must be LOCAL_OWNER_USER_ID

export type ChannelSecrets = {
  v: 1;
  links: Record<string, { expiresAt: string; consumedAt?: string; kind: 'join' }>;           // key = sha256(token) hex
  members: Record<string, { tokenSha256: string; sessionKey?: string }>;                                          // key = user id; the owner has no entry (cookie auth)
};


// GET  /api/local/rooms/:roomId/me
export type LocalMe = { userId: string; roomId: string; roomName: string; membership: 'invite' | 'join' | 'leave'; invitedBy?: string; displayName: string };
// POST /api/local/rooms/:roomId/join                 body {} → LocalJoined   (invite → join; appends the join member event; idempotent when already joined)
export type LocalJoined = { seq: number; ts: number };   // seq of the caller's own join event = the live cutoff
// GET  /api/local/rooms/:roomId/events?after=<seq>&wait=<0..25>
export type LocalEventsPage = { events: LocalEvent[]; next: number };   // events with seq > after, ascending, at most 200; next = last seq returned or `after`
//   answers immediately when an event with seq > after exists, else holds up to `wait` seconds and answers {events:[], next:after}
// GET  /api/local/rooms/:roomId/messages?before=<eventId>&limit=<1..100>
export type LocalHistoryPage = { events: LocalEvent[]; nextBefore?: string };   // m.room.message + com.khala.event.v1 only, oldest first, strictly older than `before`; nextBefore = oldest eventId when older ones exist
// POST /api/local/rooms/:roomId/send
export type LocalSendRequest = { txnId: string; type: 'm.room.message' | 'com.khala.event.v1'; content: Record<string, unknown> };   // txnId 1..64 chars [A-Za-z0-9._-]
export type LocalSendResult = { eventId: string };   // replays the same eventId for a repeated (sender, txnId)
// GET  /api/local/rooms/:roomId/members
export type LocalMember = {
  userId: string;                    // "@khala_owner:local" | "@agent-<8hex>:local"; the web uses it as Participant.matrixUserId
  participantId: string;             // = userId (the web's ParticipantId)
  ownerId: typeof LOCAL_OWNER_ID;    // every member belongs to the one owner
  deviceId: string;                  // agents "KH_LOCAL_<8hex>", the owner LOCAL_OWNER_DEVICE_ID; the web's authorDeviceId
  displayName: string; kind: 'human' | 'agent'; harness?: Harness;
  ownerLabel?: string;               // agents: the owner's username (Participant.ownerLabel)
  membership: 'invite' | 'join';
  listeningMode?: 'steer' | 'sync' | 'async';   // agents only; DEFAULT_LISTENING_MODE when never echoed
};
export type LocalMembersResponse = { members: LocalMember[] };   // present members only
export const LOCAL_OWNER_ID = 'local-owner' as const;             // the web's OwnerId / AuthPrincipal.ownerId
export const LOCAL_OWNER_DEVICE_ID = 'KH_LOCAL_OWNER' as const;
// PUT  /api/local/rooms/:roomId/members/:userId      body {listeningMode}  → 204   (caller must be :userId and an agent; appends a member event echoing the mode)

export type LocalChannelsPage = { revision: number; channels: LocalChannelSummary[] };   // revision: helper-wide counter bumped on every append/create/delete (in memory; restarts at 0)
export type LocalChannelSummary = {
  roomId: string; name: string; createdAt: string; lastSeq: number; lastTs: number;
  preview: string | null;                                  // body of the latest m.room.message (m.text), else null
  lastSender?: { userId: string; displayName: string };    // sender of that message
  // present members, owner first; since = ts of the member's latest membership event (owner routes only: the CLI never decodes summaries)
  members: { userId: string; displayName: string; kind: 'human' | 'agent'; harness?: Harness; since?: number }[];
};
// POST   /api/local/channels           body {name, operationId?} → LocalChannelCreated   (name 1..64 chars, trimmed; appends create + owner join; operationId 1..64 [A-Za-z0-9._-] is stored in the create content and is idempotent)
export type LocalChannelCreated = { roomId: string; name: string; selfLink: string; shareLink: string; openUrl: string; expiresAt: string };

export type OwnerProfile = { v: 1; username: string; color: HumanColorId; initials: string | null; updatedAt: string };   // <stateRoot>/local/owner.json
export type OwnerProfileView = { userId: typeof LOCAL_OWNER_USER_ID; ownerId: typeof LOCAL_OWNER_ID; username: string; suggestion: string; color: HumanColorId; initials: string | null };

export type HelperFile = { v: 1; pid: number; port: number; origin: string; adminToken: string; version: string; startedAt: string };

export type LocalShareLink = { shareLink: string; expiresAt: string };
export type LocalOpenLink = { openUrl: string; expiresAt: string };
export type LocalRoomRef = { roomId: string };
export type LocalHealth = { ok: true; version: string; pid: number };
export type LocalErrorBody = { error: string };

export function readLocalRoomId(input: unknown, path: string): string {
  const value = readRoomId(input, path);
  if (!isLocalRoomId(value)) fail(path, 'invalid_value');
  return value;
}
export function readLocalUserId(input: unknown, path: string): string {
  const value = readMatrixUserId(input, path);
  if (!isLocalUserId(value)) fail(path, 'invalid_value');
  return value;
}
export function readLocalEventId(input: unknown, path: string): string {
  const value = identifier(input, path);
  if (!isLocalEventId(value)) fail(path, 'invalid_value');
  return value;
}
export function readLocalTxnId(input: unknown, path: string): string {
  const value = identifier(input, path);
  if (!isLocalTxnId(value)) fail(path, 'invalid_value');
  return value;
}
export function readLocalUsername(input: unknown, path: string): string {
  const value = identifier(input, path);
  const checked = checkName(value, 'username');
  if (!checked.ok || checked.name !== value) fail(path, 'invalid_value');
  return value;
}
export function readLocalInitials(input: unknown, path: string): string {
  return readHumanInitials(input, path);
}

// Optional keys are allowed only when actually present, including explicit undefined.
function record(input: unknown, path: string, required: readonly string[], optional: readonly string[] = []) {
  const present = optional.filter(key => typeof input === 'object' && input !== null && Object.hasOwn(input, key));
  return object(input, path, [...required, ...present]);
}
function has(input: unknown, key: string): boolean {
  return typeof input === 'object' && input !== null && Object.hasOwn(input, key);
}
function plainObject(input: unknown, path: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail(path, 'not_object');
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) fail(path, 'not_object');
  return input as Record<string, unknown>;
}
function contentObject(input: unknown, path: string): Record<string, unknown> {
  const value = plainObject(input, path);
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { fail(path, 'invalid_value'); }
  if (utf8Length(encoded) > LOCAL_CONTENT_MAX_BYTES) fail(path, 'too_long');
  return value;
}
function channelName(input: unknown, path: string): string {
  const value = displayName(input, path);
  if ([...value].length > LOCAL_CHANNEL_NAME_MAX_CHARS) fail(path, 'too_long');
  if (value !== value.trim()) fail(path, 'invalid_value');
  return value;
}
function displayName(input: unknown, path: string): string {
  const value = displayText(input, path, M1_LABEL_MAX_BYTES);
  if (value.length === 0) fail(path, 'empty');
  return value;
}
function seq(input: unknown, path: string): number {
  const value = safeInteger(input, path);
  if (value === 0) fail(path, 'invalid_value');
  return value;
}
function readCreateContent(input: unknown, path: string): LocalCreateContent {
  const r = record(input, path, ['name', 'createdBy'], ['operationId']);
  return { name: channelName(r.field('name'), r.at('name')), createdBy: readLocalUserId(r.field('createdBy'), r.at('createdBy')),
    ...(has(input, 'operationId') ? { operationId: readLocalTxnId(r.field('operationId'), r.at('operationId')) } : {}) };
}
function readNameContent(input: unknown, path: string): LocalNameContent {
  const r = object(input, path, ['name']);
  return { name: channelName(r.field('name'), r.at('name')) };
}
function readMemberContent(input: unknown, path: string): LocalMemberContent {
  const modeKey = 'com.khala.listening_mode';
  const r = record(input, path, ['user', 'membership', 'displayname', 'kind'], ['harness', 'invitedBy', modeKey]);
  const kind = literal(r.field('kind'), r.at('kind'), ['human', 'agent']);
  if (kind === 'human') for (const key of ['harness', modeKey]) if (has(input, key)) fail(r.at(key), 'invalid_value');
  return { user: readLocalUserId(r.field('user'), r.at('user')),
    membership: literal(r.field('membership'), r.at('membership'), ['invite', 'join', 'leave']),
    displayname: displayName(r.field('displayname'), r.at('displayname')), kind,
    ...(has(input, 'harness') ? { harness: readHarness(r.field('harness'), r.at('harness')) } : {}),
    ...(has(input, 'invitedBy') ? { invitedBy: readLocalUserId(r.field('invitedBy'), r.at('invitedBy')) } : {}),
    ...(has(input, modeKey) ? { [modeKey]: literal(r.field(modeKey), r.at(modeKey), LISTENING_MODES) } : {}) };
}
export function decodeLocalCreateContent(input: unknown): Decoded<LocalCreateContent> { return decodeWith(() => readCreateContent(input, '')); }
export function decodeLocalNameContent(input: unknown): Decoded<LocalNameContent> { return decodeWith(() => readNameContent(input, '')); }
export function decodeLocalMemberContent(input: unknown): Decoded<LocalMemberContent> { return decodeWith(() => readMemberContent(input, '')); }

const EVENT_TYPES = ['m.room.create', 'm.room.name', 'm.room.member', 'm.room.message', 'com.khala.event.v1', 'com.khala.listening_mode.v1'] as const;
function readContent(input: unknown, path: string, type: LocalEventType): Record<string, unknown> {
  switch (type) {
    case 'm.room.create': return readCreateContent(input, path);
    case 'm.room.name': return readNameContent(input, path);
    case 'm.room.member': return readMemberContent(input, path);
    default: {
      const content = contentObject(input, path);
      if (type === 'm.room.message') {
        literal(content['msgtype'], `${path}.msgtype`, ['m.text', 'm.notice']);
        const body = text(content['body'], `${path}.body`, LOCAL_CONTENT_MAX_BYTES);
        if (body.length === 0) fail(`${path}.body`, 'empty');
        if (body.length > LOCAL_BODY_MAX_CHARS) fail(`${path}.body`, 'too_long');
      }
      return content;
    }
  }
}
function readEvent(input: unknown, path: string): LocalEvent {
  const r = record(input, path, ['seq', 'eventId', 'roomId', 'type', 'sender', 'ts', 'content'], ['txnId', 'previousContent']);
  const type = literal(r.field('type'), r.at('type'), EVENT_TYPES);
  return { seq: seq(r.field('seq'), r.at('seq')), eventId: readLocalEventId(r.field('eventId'), r.at('eventId')),
    roomId: readLocalRoomId(r.field('roomId'), r.at('roomId')), type,
    sender: readLocalUserId(r.field('sender'), r.at('sender')), ts: safeInteger(r.field('ts'), r.at('ts')),
    ...(has(input, 'txnId') ? { txnId: readLocalTxnId(r.field('txnId'), r.at('txnId')) } : {}),
    content: readContent(r.field('content'), r.at('content'), type),
    ...(has(input, 'previousContent') ? { previousContent: readMemberContent(r.field('previousContent'), r.at('previousContent')) } : {}) };
}
export function decodeLocalEvent(input: unknown): Decoded<LocalEvent> { return decodeWith(() => readEvent(input, '')); }
function limitedArray<T>(input: unknown, path: string, max: number, read: (input: unknown, path: string) => T): T[] {
  const values = array(input, path);
  if (values.length > max) fail(path, 'too_long');
  return values.map((value, i) => read(value, elementPath(path, i)));
}
function readEvents(input: unknown, path: string, history: boolean): LocalEvent[] {
  const events = limitedArray(input, path, history ? LOCAL_HISTORY_LIMIT_MAX : LOCAL_EVENTS_PAGE_MAX, readEvent);
  events.forEach((event, i) => {
    if (i > 0 && event.seq <= events[i - 1]!.seq) fail(`${elementPath(path, i)}.seq`, 'invalid_value');
    if (history && event.type !== 'm.room.message' && event.type !== 'com.khala.event.v1') fail(`${elementPath(path, i)}.type`, 'invalid_value');
  });
  return events;
}
export function decodeLocalEventsPage(input: unknown): Decoded<LocalEventsPage> {
  return decodeWith(() => {
    const r = object(input, '', ['events', 'next']);
    const events = readEvents(r.field('events'), r.at('events'), false);
    const next = safeInteger(r.field('next'), r.at('next'));
    if (events.length > 0 && next !== events.at(-1)!.seq) fail(r.at('next'), 'invalid_value');
    return { events, next };
  });
}
export function decodeLocalHistoryPage(input: unknown): Decoded<LocalHistoryPage> {
  return decodeWith(() => {
    const r = record(input, '', ['events'], ['nextBefore']);
    return { events: readEvents(r.field('events'), r.at('events'), true),
      ...(has(input, 'nextBefore') ? { nextBefore: readLocalEventId(r.field('nextBefore'), r.at('nextBefore')) } : {}) };
  });
}
export function decodeLocalSendRequest(input: unknown): Decoded<LocalSendRequest> {
  return decodeWith(() => {
    const r = object(input, '', ['txnId', 'type', 'content']);
    const type = literal(r.field('type'), r.at('type'), ['m.room.message', 'com.khala.event.v1']);
    return { txnId: readLocalTxnId(r.field('txnId'), r.at('txnId')), type, content: readContent(r.field('content'), r.at('content'), type) };
  });
}

function readLocalMe(input: unknown, path: string): LocalMe {
  const r = record(input, path, ['userId', 'roomId', 'roomName', 'membership', 'displayName'], ['invitedBy']);
  return {
    userId: readLocalUserId(r.field('userId'), r.at('userId')),
    roomId: readLocalRoomId(r.field('roomId'), r.at('roomId')),
    roomName: channelName(r.field('roomName'), r.at('roomName')),
    membership: literal(r.field('membership'), r.at('membership'), ['invite', 'join', 'leave']),
    ...(has(input, 'invitedBy') ? { invitedBy: readLocalUserId(r.field('invitedBy'), r.at('invitedBy')) } : {}),
    displayName: displayName(r.field('displayName'), r.at('displayName')),
  };
}
export function decodeLocalMe(input: unknown): Decoded<LocalMe> { return decodeWith(() => readLocalMe(input, '')); }

function readLocalJoined(input: unknown, path: string): LocalJoined {
  const r = record(input, path, ['seq', 'ts'], []);
  return {
    seq: seq(r.field('seq'), r.at('seq')),
    ts: safeInteger(r.field('ts'), r.at('ts')),
  };
}
export function decodeLocalJoined(input: unknown): Decoded<LocalJoined> { return decodeWith(() => readLocalJoined(input, '')); }

function readLocalSendResult(input: unknown, path: string): LocalSendResult {
  const r = record(input, path, ['eventId'], []);
  return {
    eventId: readLocalEventId(r.field('eventId'), r.at('eventId')),
  };
}
export function decodeLocalSendResult(input: unknown): Decoded<LocalSendResult> { return decodeWith(() => readLocalSendResult(input, '')); }

function readLocalChannelSummary(input: unknown, path: string): LocalChannelSummary {
  const r = record(input, path, ['roomId', 'name', 'createdAt', 'lastSeq', 'lastTs', 'preview', 'members'], ['lastSender']);
  return {
    roomId: readLocalRoomId(r.field('roomId'), r.at('roomId')),
    name: channelName(r.field('name'), r.at('name')),
    createdAt: utcTimestamp(r.field('createdAt'), r.at('createdAt')),
    lastSeq: safeInteger(r.field('lastSeq'), r.at('lastSeq')),
    lastTs: safeInteger(r.field('lastTs'), r.at('lastTs')),
    preview: nullableText(r.field('preview'), r.at('preview')),
    ...(has(input, 'lastSender') ? { lastSender: readSender(r.field('lastSender'), r.at('lastSender')) } : {}),
    members: readSummaryMembers(r.field('members'), r.at('members')),
  };
}
export function decodeLocalChannelSummary(input: unknown): Decoded<LocalChannelSummary> { return decodeWith(() => readLocalChannelSummary(input, '')); }

function readLocalChannelsPage(input: unknown, path: string): LocalChannelsPage {
  const r = record(input, path, ['revision', 'channels'], []);
  return {
    revision: safeInteger(r.field('revision'), r.at('revision')),
    channels: readChannels(r.field('channels'), r.at('channels')),
  };
}
export function decodeLocalChannelsPage(input: unknown): Decoded<LocalChannelsPage> { return decodeWith(() => readLocalChannelsPage(input, '')); }

function readLocalChannelCreated(input: unknown, path: string): LocalChannelCreated {
  const r = record(input, path, ['roomId', 'name', 'selfLink', 'shareLink', 'openUrl', 'expiresAt'], []);
  return {
    roomId: readLocalRoomId(r.field('roomId'), r.at('roomId')),
    name: channelName(r.field('name'), r.at('name')),
    selfLink: readChannelLink(r.field('selfLink'), r.at('selfLink')),
    shareLink: readChannelLink(r.field('shareLink'), r.at('shareLink')),
    openUrl: readOpenUrl(r.field('openUrl'), r.at('openUrl')),
    expiresAt: utcTimestamp(r.field('expiresAt'), r.at('expiresAt')),
  };
}
export function decodeLocalChannelCreated(input: unknown): Decoded<LocalChannelCreated> { return decodeWith(() => readLocalChannelCreated(input, '')); }

function readLocalShareLink(input: unknown, path: string): LocalShareLink {
  const r = record(input, path, ['shareLink', 'expiresAt'], []);
  return {
    shareLink: readChannelLink(r.field('shareLink'), r.at('shareLink')),
    expiresAt: utcTimestamp(r.field('expiresAt'), r.at('expiresAt')),
  };
}
export function decodeLocalShareLink(input: unknown): Decoded<LocalShareLink> { return decodeWith(() => readLocalShareLink(input, '')); }

function readLocalOpenLink(input: unknown, path: string): LocalOpenLink {
  const r = record(input, path, ['openUrl', 'expiresAt'], []);
  return {
    openUrl: readOpenUrl(r.field('openUrl'), r.at('openUrl')),
    expiresAt: utcTimestamp(r.field('expiresAt'), r.at('expiresAt')),
  };
}
export function decodeLocalOpenLink(input: unknown): Decoded<LocalOpenLink> { return decodeWith(() => readLocalOpenLink(input, '')); }

function readLocalRoomRef(input: unknown, path: string): LocalRoomRef {
  const r = record(input, path, ['roomId'], []);
  return {
    roomId: readLocalRoomId(r.field('roomId'), r.at('roomId')),
  };
}
export function decodeLocalRoomRef(input: unknown): Decoded<LocalRoomRef> { return decodeWith(() => readLocalRoomRef(input, '')); }

function readLocalHealth(input: unknown, path: string): LocalHealth {
  const r = record(input, path, ['ok', 'version', 'pid'], []);
  return {
    ok: readTrue(r.field('ok'), r.at('ok')),
    version: identifier(r.field('version'), r.at('version')),
    pid: safeInteger(r.field('pid'), r.at('pid')),
  };
}
export function decodeLocalHealth(input: unknown): Decoded<LocalHealth> { return decodeWith(() => readLocalHealth(input, '')); }

function readLocalErrorBody(input: unknown, path: string): LocalErrorBody {
  const r = record(input, path, ['error'], []);
  return {
    error: identifier(r.field('error'), r.at('error')),
  };
}
export function decodeLocalErrorBody(input: unknown): Decoded<LocalErrorBody> { return decodeWith(() => readLocalErrorBody(input, '')); }

function readOwnerProfile(input: unknown, path: string): OwnerProfile {
  const r = record(input, path, ['v', 'username', 'color', 'initials', 'updatedAt']);
  return {
    v: version(r.field('v'), r.at('v')),
    username: readLocalUsername(r.field('username'), r.at('username')),
    color: readHumanColorId(r.field('color'), r.at('color')),
    initials: nullableInitials(r.field('initials'), r.at('initials')),
    updatedAt: utcTimestamp(r.field('updatedAt'), r.at('updatedAt')),
  };
}
export function decodeOwnerProfile(input: unknown): Decoded<OwnerProfile> { return decodeWith(() => readOwnerProfile(input, '')); }

function readOwnerProfileView(input: unknown, path: string): OwnerProfileView {
  const r = record(input, path, ['userId', 'ownerId', 'username', 'suggestion', 'color', 'initials']);
  return {
    userId: literal(r.field('userId'), r.at('userId'), [LOCAL_OWNER_USER_ID]),
    ownerId: literal(r.field('ownerId'), r.at('ownerId'), [LOCAL_OWNER_ID]),
    username: readLocalUsername(r.field('username'), r.at('username')),
    suggestion: readLocalUsername(r.field('suggestion'), r.at('suggestion')),
    color: readHumanColorId(r.field('color'), r.at('color')),
    initials: nullableInitials(r.field('initials'), r.at('initials')),
  };
}
export function decodeOwnerProfileView(input: unknown): Decoded<OwnerProfileView> { return decodeWith(() => readOwnerProfileView(input, '')); }

function readOwnerUsernameResult(input: unknown, path: string): { username: string } {
  const r = record(input, path, ['username'], []);
  return {
    username: readLocalUsername(r.field('username'), r.at('username')),
  };
}
export function decodeOwnerUsernameResult(input: unknown): Decoded<{ username: string }> { return decodeWith(() => readOwnerUsernameResult(input, '')); }

function readOwnerColorResult(input: unknown, path: string): { color: HumanColorId } {
  const r = record(input, path, ['color'], []);
  return {
    color: readHumanColorId(r.field('color'), r.at('color')),
  };
}
export function decodeOwnerColorResult(input: unknown): Decoded<{ color: HumanColorId }> { return decodeWith(() => readOwnerColorResult(input, '')); }

function readOwnerInitialsResult(input: unknown, path: string): { initials: string | null } {
  const r = record(input, path, ['initials'], []);
  return {
    initials: nullableInitials(r.field('initials'), r.at('initials')),
  };
}
export function decodeOwnerInitialsResult(input: unknown): Decoded<{ initials: string | null }> { return decodeWith(() => readOwnerInitialsResult(input, '')); }

function nullableText(input: unknown, path: string): string | null {
  return nullable(input, value => text(value, path, LOCAL_CONTENT_MAX_BYTES));
}
function nullableInitials(input: unknown, path: string): string | null {
  return nullable(input, value => readLocalInitials(value, path));
}
function readTrue(input: unknown, path: string): true {
  if (input !== true) fail(path, 'invalid_value');
  return true;
}
function readOpenUrl(input: unknown, path: string): string {
  const value = readHttpUrl(input, path);
  if (!/^\/open\/[A-Za-z0-9_-]{43}$/u.test(new URL(value).pathname)) fail(path, 'invalid_value');
  return value;
}
function readSender(input: unknown, path: string): { userId: string; displayName: string } {
  const r = object(input, path, ['userId', 'displayName']);
  return { userId: readLocalUserId(r.field('userId'), r.at('userId')), displayName: displayName(r.field('displayName'), r.at('displayName')) };
}
function readSummaryMembers(input: unknown, path: string): LocalChannelSummary['members'] {
  return limitedArray(input, path, LOCAL_MEMBERS_MAX, (value, at) => {
    const r = record(value, at, ['userId', 'displayName', 'kind'], ['harness', 'since']);
    const kind = literal(r.field('kind'), r.at('kind'), ['human', 'agent']);
    if (kind === 'human' && has(value, 'harness')) fail(r.at('harness'), 'invalid_value');
    return { userId: readLocalUserId(r.field('userId'), r.at('userId')), displayName: displayName(r.field('displayName'), r.at('displayName')), kind,
      ...(has(value, 'harness') ? { harness: readHarness(r.field('harness'), r.at('harness')) } : {}),
      ...(has(value, 'since') ? { since: safeInteger(r.field('since'), r.at('since')) } : {}) };
  });
}
function readChannels(input: unknown, path: string): LocalChannelSummary[] {
  return array(input, path).map((value, i) => readLocalChannelSummary(value, elementPath(path, i)));
}
function readMember(input: unknown, path: string): LocalMember {
  const r = record(input, path, ['userId', 'participantId', 'ownerId', 'deviceId', 'displayName', 'kind', 'membership'], ['harness', 'ownerLabel', 'listeningMode']);
  const userId = readLocalUserId(r.field('userId'), r.at('userId'));
  const participantId = readLocalUserId(r.field('participantId'), r.at('participantId'));
  if (participantId !== userId) fail(r.at('participantId'), 'invalid_value');
  const deviceId = identifier(r.field('deviceId'), r.at('deviceId'));
  if (userId === LOCAL_OWNER_USER_ID ? deviceId !== LOCAL_OWNER_DEVICE_ID : !/^KH_LOCAL_[0-9a-f]{8}$/u.test(deviceId)) fail(r.at('deviceId'), 'invalid_value');
  const kind = literal(r.field('kind'), r.at('kind'), ['human', 'agent']);
  if (kind === 'human') for (const key of ['harness', 'ownerLabel', 'listeningMode']) if (has(input, key)) fail(r.at(key), 'invalid_value');
  return { userId, participantId, ownerId: literal(r.field('ownerId'), r.at('ownerId'), [LOCAL_OWNER_ID]), deviceId,
    displayName: displayName(r.field('displayName'), r.at('displayName')), kind,
    membership: literal(r.field('membership'), r.at('membership'), ['invite', 'join']),
    ...(has(input, 'harness') ? { harness: readHarness(r.field('harness'), r.at('harness')) } : {}),
    ...(has(input, 'ownerLabel') ? { ownerLabel: readLocalUsername(r.field('ownerLabel'), r.at('ownerLabel')) } : {}),
    ...(has(input, 'listeningMode') ? { listeningMode: literal(r.field('listeningMode'), r.at('listeningMode'), LISTENING_MODES) } : {}) };
}
export function decodeLocalMember(input: unknown): Decoded<LocalMember> { return decodeWith(() => readMember(input, '')); }
export function decodeLocalMembersResponse(input: unknown): Decoded<LocalMembersResponse> {
  return decodeWith(() => {
    const r = object(input, '', ['members']);
    const members = limitedArray(r.field('members'), r.at('members'), LOCAL_MEMBERS_MAX, readMember);
    const seen = new Set<string>();
    members.forEach((member, i) => {
      if (seen.has(member.userId)) fail(`${elementPath(r.at('members'), i)}.userId`, 'duplicate');
      seen.add(member.userId);
    });
    return { members };
  });
}
export function decodeHelperFile(input: unknown): Decoded<HelperFile> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'pid', 'port', 'origin', 'adminToken', 'version', 'startedAt']);
    const pid = seq(r.field('pid'), r.at('pid'));
    const port = seq(r.field('port'), r.at('port'));
    if (port > 65535) fail(r.at('port'), 'invalid_value');
    const origin = readHttpUrl(r.field('origin'), r.at('origin'));
    if (origin !== `http://127.0.0.1:${port}`) fail(r.at('origin'), 'invalid_value');
    const adminToken = identifier(r.field('adminToken'), r.at('adminToken'));
    if (!/^[A-Za-z0-9_-]{43}$/u.test(adminToken)) fail(r.at('adminToken'), 'invalid_value');
    return { v: version(r.field('v'), r.at('v')), pid, port, origin, adminToken,
      version: identifier(r.field('version'), r.at('version')), startedAt: utcTimestamp(r.field('startedAt'), r.at('startedAt')) };
  });
}
function readSha256(input: unknown, path: string): string {
  const value = identifier(input, path);
  if (!/^[0-9a-f]{64}$/u.test(value)) fail(path, 'invalid_value');
  return value;
}
export function decodeChannelSecrets(input: unknown): Decoded<ChannelSecrets> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'links', 'members']);
    const links = Object.fromEntries(Object.entries(plainObject(r.field('links'), r.at('links'))).map(([key, value]) => {
      const path = `${r.at('links')}.${key}`;
      readSha256(key, path);
      const link = record(value, path, ['expiresAt', 'kind'], ['consumedAt']);
      return [key, { expiresAt: utcTimestamp(link.field('expiresAt'), link.at('expiresAt')),
        kind: literal(link.field('kind'), link.at('kind'), ['join']),
        ...(has(value, 'consumedAt') ? { consumedAt: utcTimestamp(link.field('consumedAt'), link.at('consumedAt')) } : {}) }];
    }));
    const members = Object.fromEntries(Object.entries(plainObject(r.field('members'), r.at('members'))).map(([key, value]) => {
      const path = `${r.at('members')}.${key}`;
      if (!isLocalAgentUserId(key)) fail(path, 'invalid_value');
      const member = record(value, path, ['tokenSha256'], ['sessionKey']);
      return [key, { tokenSha256: readSha256(member.field('tokenSha256'), member.at('tokenSha256')),
        ...(has(value, 'sessionKey') ? { sessionKey: readSha256(member.field('sessionKey'), member.at('sessionKey')) } : {}) }];
    }));
    return { v: version(r.field('v'), r.at('v')), links, members };
  });
}
