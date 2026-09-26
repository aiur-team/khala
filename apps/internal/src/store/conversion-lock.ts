import type { DatabaseSync } from 'node:sqlite';

// Write state of an internal channel under conversion, kept in `control_records` so the
// conversion journal can change it in the same transaction as its own record. `paused`
// is the final write pause before the link commit; `linked` is permanent: the channel
// became read-only when its external channel took over.

export type ChannelConversionLock = Readonly<{
  conversionId: string;
  write: 'open' | 'paused' | 'linked';
  destinationChannelId: string | null;
}>;

export const channelConversionKey = (channelId: string): string => `channel-conversion.v1.${channelId}`;

export function readChannelConversionLock(db: DatabaseSync, channelId: string): ChannelConversionLock | null {
  const row = db.prepare('SELECT value FROM control_records WHERE record_key = ?')
    .get(channelConversionKey(channelId)) as { value: string } | undefined;
  return row ? JSON.parse(row.value) as ChannelConversionLock : null;
}

/** False while the conversion pauses writes and forever after the link commit. */
export function isChannelWritable(db: DatabaseSync, channelId: string): boolean {
  const lock = readChannelConversionLock(db, channelId);
  return lock === null || lock.write === 'open';
}
