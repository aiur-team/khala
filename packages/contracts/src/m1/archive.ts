/**
 * A human's per-channel archive flag, kept in their own `m.room.member` content
 * so it syncs across their devices and their agents can read it as room state.
 * Agents honour it only from their inviter; it can only quiet them.
 */
export const ARCHIVED_MEMBER_KEY = 'com.khala.archived' as const;

export function memberArchived(content: unknown): boolean {
  return typeof content === 'object' && content !== null && (content as Record<string, unknown>)[ARCHIVED_MEMBER_KEY] === true;
}
