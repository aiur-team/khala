import { encodeChannelEvent, type ChannelEventContent } from '@khala/contracts/m1/channel-event';

/** Join-to-join name changes exclude admissions, departures and mode echoes. */
export function memberRenameContent(content: Record<string, unknown>, previous?: Record<string, unknown>): ChannelEventContent | null {
  const oldName = previous?.['displayname'];
  const newName = content['displayname'];
  if (previous?.['membership'] !== 'join' || content['membership'] !== 'join'
    || typeof oldName !== 'string' || !oldName.trim() || typeof newName !== 'string' || !newName.trim() || oldName === newName) return null;
  const encoded = encodeChannelEvent({ kind: 'member', summary: `${oldName} is now ${newName}`, status: 'info', source: { system: 'khala' } });
  return encoded.ok ? encoded.value : null;
}
