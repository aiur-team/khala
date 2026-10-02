import { type Decoded, decodeWith, fail, identifier, label, literal, object, text, utcTimestamp } from '../messaging/decode';
import { M1_LABEL_MAX_BYTES, readMatrixUserId, readRoomId } from './agent-join';

export type InboxEntry = {
  eventId: string;            // Matrix event id; dedup key
  roomId: string;
  ts: string;                 // ISO origin_server_ts
  sender: string;             // Matrix user id
  senderLabel: string;        // e.g. "Maya" or "Codex · Maya"
  senderKind: 'human' | 'agent' | 'unknown';
  kind: 'message' | 'event';  // 'event' = channel event (events lane), never wakes
  body: string;               // plaintext; for kind 'event' the formatted line
};

export const INBOX_BODY_MAX_BYTES = 65_536;
export function decodeInboxEntry(input: unknown): Decoded<InboxEntry> {
  return decodeWith(() => {
    const r = object(input, '', ['eventId', 'roomId', 'ts', 'sender', 'senderLabel', 'senderKind', 'kind', 'body']);
    const eventId = identifier(r.field('eventId'), r.at('eventId'));
    if (!/^\$\S+$/u.test(eventId)) fail(r.at('eventId'), 'invalid_value');
    return {
      eventId,
      roomId: readRoomId(r.field('roomId'), r.at('roomId')),
      ts: utcTimestamp(r.field('ts'), r.at('ts')),
      sender: readMatrixUserId(r.field('sender'), r.at('sender')),
      senderLabel: label(r.field('senderLabel'), r.at('senderLabel'), M1_LABEL_MAX_BYTES),
      senderKind: literal(r.field('senderKind'), r.at('senderKind'), ['human', 'agent', 'unknown']),
      kind: literal(r.field('kind'), r.at('kind'), ['message', 'event']),
      body: text(r.field('body'), r.at('body'), INBOX_BODY_MAX_BYTES),
    };
  });
}

export function encodeInboxLine(entry: InboxEntry): string {
  return JSON.stringify(entry) + '\n';
}

export function decodeInboxLine(line: string): Decoded<InboxEntry> {
  let input: unknown;
  try { input = JSON.parse(line); } catch { return { ok: false, error: { path: '', code: 'invalid_value' } }; }
  return decodeInboxEntry(input);
}
