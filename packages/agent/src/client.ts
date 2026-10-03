import type { ListeningMode } from '@khala/contracts/m1/listening-mode';
import type { ChannelEventContent } from '@khala/contracts/m1/channel-event';
import type { InboxEntry } from '@khala/contracts/m1/inbox';

export interface KhalaAgentClient {
  join(link: string, label: string): Promise<{ state: 'awaiting_confirmation'; confirmUrl: string; autoConfirmed?: true } | { state: 'connected'; channelName: string }>;
  status(): Promise<{ state: string; detail?: string; channelName?: string; agentUserId?: string; unread: number; listeningMode: ListeningMode }>;
  read(limit: number, before?: string): Promise<{ messages: InboxEntry[]; nextBefore?: string }>;
  send(text: string): Promise<{ eventId: string }>;
  sendChannelEvent(content: ChannelEventContent): Promise<{ eventId: string }>;
  close(): Promise<void>;
}

export type KhalaErrorCode = 'invalid_link' | 'link_unavailable' | 'join_expired' | 'not_connected' | 'send_failed' | 'session_unknown' | 'internal_error';
export class KhalaClientError extends Error {
  readonly code: KhalaErrorCode;
  constructor(code: KhalaErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'KhalaClientError';
    this.code = code;
  }
}
