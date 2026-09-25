import type { RoomId } from '@khala/contracts/messaging/index';

const TIMELINE_DOMAIN = 'khala.timeline.cursor';
const SUBSCRIPTION_DOMAIN = 'khala.subscription.cursor';
const CURSOR_VERSION = 1;

type TimelineCursorPayload = readonly [
  typeof TIMELINE_DOMAIN, typeof CURSOR_VERSION, string, number, number, number,
];
type SubscriptionCursorPayload = readonly [
  typeof SUBSCRIPTION_DOMAIN, typeof CURSOR_VERSION, string, string, number, number,
];
type CursorPayload = TimelineCursorPayload | SubscriptionCursorPayload;

export type TimelineCursor = Readonly<{
  channelId: RoomId;
  snapshotHighWater: number;
  snapshotRevision: number;
  beforeSequence: number;
}>;

export type SubscriptionCursor = Readonly<{
  channelId: RoomId;
  bindingId: string;
  generation: number;
  lastCoveredSequence: number;
}>;

function encode(value: CursorPayload): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decode(value: string): readonly unknown[] | null {
  if (value.length === 0) return null;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) return null;
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const isNonnegativeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const isPositiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const isIdentifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\0');

export function encodeTimelineCursor(cursor: TimelineCursor): string {
  return encode([
    TIMELINE_DOMAIN, CURSOR_VERSION, cursor.channelId, cursor.snapshotHighWater,
    cursor.snapshotRevision, cursor.beforeSequence,
  ]);
}

export function decodeTimelineCursor(value: string): TimelineCursor | null {
  const raw = decode(value);
  if (raw?.length !== 6 || raw[0] !== TIMELINE_DOMAIN || raw[1] !== CURSOR_VERSION
    || !isIdentifier(raw[2]) || !isNonnegativeInteger(raw[3])
    || !isNonnegativeInteger(raw[4]) || !isPositiveInteger(raw[5])) return null;
  return {
    channelId: raw[2] as RoomId,
    snapshotHighWater: raw[3],
    snapshotRevision: raw[4],
    beforeSequence: raw[5],
  };
}

export function encodeSubscriptionCursor(cursor: SubscriptionCursor): string {
  return encode([
    SUBSCRIPTION_DOMAIN, CURSOR_VERSION, cursor.channelId, cursor.bindingId,
    cursor.generation, cursor.lastCoveredSequence,
  ]);
}

export function decodeSubscriptionCursor(value: string): SubscriptionCursor | null {
  const raw = decode(value);
  if (raw?.length !== 6 || raw[0] !== SUBSCRIPTION_DOMAIN || raw[1] !== CURSOR_VERSION
    || !isIdentifier(raw[2]) || !isIdentifier(raw[3])
    || !isNonnegativeInteger(raw[4]) || !isNonnegativeInteger(raw[5])) return null;
  return {
    channelId: raw[2] as RoomId,
    bindingId: raw[3],
    generation: raw[4],
    lastCoveredSequence: raw[5],
  };
}
