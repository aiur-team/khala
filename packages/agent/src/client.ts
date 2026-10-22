import type { ListeningMode } from '@khala/contracts/m1/listening-mode';
import type { ChannelEventContent } from '@khala/contracts/m1/channel-event';
import type { InboxEntry } from '@khala/contracts/m1/inbox';
import type { CoordinationState } from '@khala/contracts/m1/channel-event';

export type ReadFilter = { kinds?: string[]; mentionsOnly?: boolean };
export type ClaimConflict = { error: 'claimed'; by: string; at: string };
import type { MemberPresence } from './transport';

export interface KhalaAgentClient {
  resume?(): Promise<void>;
  join(link: string, label: string): Promise<{ state: 'awaiting_confirmation'; confirmUrl: string; autoConfirmed?: true } | { state: 'connected'; channelName: string; channels?: string[] }>;
  status(channel?: string): Promise<{ state: string; detail?: string; channelName?: string; agentUserId?: string; displayName?: string; you?: string; unread: number; idleWake?: import('./wake/status').IdleWakeStatus; watcherArmed?: boolean; watcherHint?: string; listeningMode?: ListeningMode; channels?: ChannelStatus[] }>;
  /** `you` is your own current display name in the channel. `members` and `seenBy` (on your own messages) are hosted only. */
  /** Derived coordination state is present only when nonempty. */
  read(limit: number, before?: string, channel?: string, filter?: ReadFilter): Promise<{ you?: string; members?: MemberPresence[]; messages: (InboxEntry & { seenBy?: string[] })[]; nextBefore?: string; wakeNotice?: string } & Partial<CoordinationState>>;
  send(text: string, channel?: string): Promise<{ eventId: string }>;
  /** A claim on a key someone else holds is not posted (or loses the race) and returns ClaimConflict. */
  sendChannelEvent(content: ChannelEventContent, channel?: string): Promise<{ eventId: string } | ClaimConflict>;
  leave(channel: string): Promise<{ left: string; channels: string[] }>;
  close(): Promise<void>;
}

export type ChannelStatus = { channel: string; roomId?: string; link?: string; state: string; detail?: string; you?: string; agentUserId?: string; unread: number; listeningMode: ListeningMode; members?: MemberPresence[] };

export type KhalaErrorCode = 'update_required' | 'channel_required' | 'channel_unknown' | 'channel_ambiguous' | 'channel_limit' | 'invalid_link' | 'link_unavailable' | 'join_expired' | 'not_connected' | 'send_failed' | 'session_unknown' | 'secret_detected' | 'internal_error';
export class KhalaClientError extends Error {
  readonly code: KhalaErrorCode;
  constructor(code: KhalaErrorCode, message?: string, readonly extra?: { channels?: { channel: string; roomId: string }[]; kind?: string }) {
    super(message ?? code);
    this.name = 'KhalaClientError';
    this.code = code;
  }
}
