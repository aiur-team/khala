import type { ListeningMode } from '@khala/contracts/m1/listening-mode';
import type { ChannelEventContent } from '@khala/contracts/m1/channel-event';
import type { InboxEntry } from '@khala/contracts/m1/inbox';

export interface KhalaAgentClient {
  resume?(): Promise<void>;
  join(link: string, label: string): Promise<{ state: 'awaiting_confirmation'; confirmUrl: string; autoConfirmed?: true } | { state: 'connected'; channelName: string; channels?: string[] }>;
  status(channel?: string): Promise<{ state: string; detail?: string; channelName?: string; agentUserId?: string; displayName?: string; you?: string; unread: number; idleWake?: import('./wake/status').IdleWakeStatus; watcherArmed?: boolean; watcherHint?: string; listeningMode?: ListeningMode; channels?: ChannelStatus[] }>;
  /** `you` is your own current display name in the channel. */
  read(limit: number, before?: string, channel?: string): Promise<{ you?: string; messages: InboxEntry[]; nextBefore?: string; wakeNotice?: string }>;
  send(text: string, channel?: string): Promise<{ eventId: string }>;
  sendChannelEvent(content: ChannelEventContent, channel?: string): Promise<{ eventId: string }>;
  leave(channel: string): Promise<{ left: string; channels: string[] }>;
  close(): Promise<void>;
}

export type ChannelStatus = { channel: string; roomId?: string; link?: string; state: string; detail?: string; you?: string; agentUserId?: string; unread: number; listeningMode: ListeningMode };

export type KhalaErrorCode = 'update_required' | 'channel_required' | 'channel_unknown' | 'channel_ambiguous' | 'channel_limit' | 'invalid_link' | 'link_unavailable' | 'join_expired' | 'not_connected' | 'send_failed' | 'session_unknown' | 'internal_error';
export class KhalaClientError extends Error {
  readonly code: KhalaErrorCode;
  constructor(code: KhalaErrorCode, message?: string, readonly extra?: { channels: { channel: string; roomId: string }[] }) {
    super(message ?? code);
    this.name = 'KhalaClientError';
    this.code = code;
  }
}
