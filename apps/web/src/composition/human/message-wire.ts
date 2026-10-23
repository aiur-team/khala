import { CHANNEL_EVENT_TYPE, decodeChannelEvent, memberRenameContent } from '@khala/contracts/m1/channel-event';
import {
  decodeMessageContent,
  type ContentLimits,
  type DeviceId,
  type EventId,
  type MessageContent,
  type ParticipantView,
} from '@khala/contracts/messaging/index';
import type { SubstrateEvent } from '@khala/messaging/channels/index';

/** Matrix-compatible content shared by hosted and local transports. */
export function encodeMessageContent(content: MessageContent): Record<string, unknown> {
  return content.kind === 'agent_rename' || content.kind === 'agent_name_snapshot'
    ? { msgtype: 'm.notice', body: content.body,
        'com.khala.agent_participant_id': content.agentParticipantId,
        ...(content.kind === 'agent_name_snapshot' ? { 'com.khala.name_snapshot': true, 'com.khala.name_source_event_id': content.sourceEventId } : {}) }
    : { msgtype: 'm.text', body: content.body,
        // Matrix v1.13 rich reply, without the removed body fallback (MSC2781).
        ...(content.inReplyTo ? { 'm.relates_to': { 'm.in_reply_to': { event_id: content.inReplyTo } } } : {}) };
}

/** The rich-reply parent, if any. Matrix clients other than Khala may still send a legacy fallback. */
function replyParent(content: Record<string, unknown>): string | undefined {
  const relates = content['m.relates_to'];
  const reply = typeof relates === 'object' && relates !== null ? (relates as Record<string, unknown>)['m.in_reply_to'] : undefined;
  const id = typeof reply === 'object' && reply !== null ? (reply as Record<string, unknown>).event_id : undefined;
  return typeof id === 'string' ? id : undefined;
}

/** Drops a legacy reply fallback: leading `> ` lines followed by one blank line. */
export function stripReplyFallback(body: string): string {
  const lines = body.split('\n');
  let quoted = 0;
  while (quoted < lines.length && lines[quoted]!.startsWith('>')) quoted += 1;
  if (quoted === 0 || lines[quoted] !== '') return body;
  const rest = lines.slice(quoted + 1).join('\n');
  return rest.length > 0 ? rest : body;
}

export function projectWireEvent(input: {
  type: string;
  content: Record<string, unknown>;
  eventId: EventId;
  participant: ParticipantView;
  authorDeviceId: DeviceId | null;
  clientTxnId: string | null;
  receivedAt: string;
  /** The sender's preceding membership content, which a name change is read against. */
  previousContent?: Record<string, unknown>;
}, limits: ContentLimits): SubstrateEvent | null {
  const { type, content: rawContent, eventId, participant, authorDeviceId, clientTxnId, receivedAt } = input;
  if (type === CHANNEL_EVENT_TYPE) {
    const decoded = decodeChannelEvent(rawContent);
    return decoded.ok ? { kind: 'channel_event', eventId, participant, content: decoded.value, receivedAt } : null;
  }
  if (type === 'm.room.member') {
    // A name change is a membership event; it reads as the same pill live and from history.
    const renamed = memberRenameContent(rawContent, input.previousContent);
    return renamed ? { kind: 'channel_event', eventId, participant, content: renamed, receivedAt } : null;
  }
  if (type !== 'm.room.message') return null;
  if (rawContent.msgtype !== 'm.text' && rawContent.msgtype !== 'm.notice') return null;
  if (rawContent.msgtype === 'm.notice' && typeof rawContent['com.khala.agent_participant_id'] !== 'string') return null;
  const parent = rawContent.msgtype === 'm.text' ? replyParent(rawContent) : undefined;
  const reply = parent !== undefined && typeof rawContent.body === 'string'
    ? decodeMessageContent({ v: 1, kind: 'text', body: stripReplyFallback(rawContent.body), inReplyTo: parent }, limits) : null;
  // A malformed parent ID is ignored: the message still shows, just not as a reply.
  const content = reply?.ok ? reply : decodeMessageContent(rawContent.msgtype === 'm.notice'
    ? { v: 1, kind: rawContent['com.khala.name_snapshot'] === true ? 'agent_name_snapshot' : 'agent_rename', body: rawContent.body,
        agentParticipantId: rawContent['com.khala.agent_participant_id'],
        ...(rawContent['com.khala.name_snapshot'] === true ? { sourceEventId: rawContent['com.khala.name_source_event_id'] } : {}) }
    : { v: 1, kind: 'text', body: rawContent.body }, limits);
  if (!content.ok || authorDeviceId === null) return null;
  return {
    kind: 'message', eventId, authorDeviceId, participant,
    content: content.value, clientTxnId, receivedAt,
  };
}
