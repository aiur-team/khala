/**
 * A human's per-channel archive flag lives in their own room account data (`{ archived: true }`): private to them,
 * synced across their devices. Their agents can't read it, so the owner's client also sends each of its agents an
 * `ARCHIVE_NOTICE_TYPE` to-device message. Agents honour a notice only from their inviter; it can only quiet them.
 */
export const ARCHIVED_ACCOUNT_DATA_TYPE = 'com.khala.archived' as const;
export const ARCHIVE_NOTICE_TYPE = 'com.khala.archive.v1' as const;
export type ArchiveNotice = Readonly<{ v: 1; room_id: string; archived: boolean }>;

export function decodeArchiveNotice(content: unknown): ArchiveNotice | undefined {
  const c = content as Partial<ArchiveNotice> | null;
  return typeof c === 'object' && c !== null && c.v === 1 && typeof c.room_id === 'string' && typeof c.archived === 'boolean'
    ? { v: 1, room_id: c.room_id, archived: c.archived } : undefined;
}

/** Legacy (#1327): the flag used to sit in the human's public member event. Read only to migrate it. */
export const ARCHIVED_MEMBER_KEY = 'com.khala.archived' as const;

export function memberArchived(content: unknown): boolean {
  return typeof content === 'object' && content !== null && (content as Record<string, unknown>)[ARCHIVED_MEMBER_KEY] === true;
}
