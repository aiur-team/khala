import type { ListeningMode } from '@khala/contracts/m1/listening-mode';
import type { ChannelEventContent } from '@khala/contracts/m1/channel-event';
import type { InboxEntry } from '@khala/contracts/m1/inbox';
import type { CoordinationState } from '@khala/contracts/m1/channel-event';

/** include: ['state'] adds openHandoffs, activeClaims and notes (also implied by kinds). wait (seconds) blocks until the channel has news and consumes it. */
export type ReadFilter = { kinds?: string[]; mentionsOnly?: boolean; include?: 'state'[]; wait?: number };
export type ClaimConflict = { error: 'claimed'; by: string; at: string };
import type { MemberPresence } from './transport';

export interface KhalaAgentClient {
  resume?(): Promise<void>;
  /** Without a link, rejoins this session's saved channels (after a restart, resume or account switch). */
  join(link: string | undefined, label: string): Promise<{ state: 'awaiting_confirmation'; confirmUrl: string; autoConfirmed?: true } | { state: 'connected'; channelName: string; channels?: string[] }>;
  status(channel?: string): Promise<{ state: string; detail?: string; channelName?: string; agentUserId?: string; displayName?: string; you?: string; unread: number; idleWake?: import('./wake/status').IdleWakeStatus; watcherArmed?: boolean; watcherHint?: string; listeningMode?: ListeningMode; archived?: true; channels?: ChannelStatus[] }>;
  /** `you` is your own current display name in the channel. `members` and `seenBy` (on your own messages) are hosted only. */
  /** Derived coordination state is present only when nonempty. */
  /** Without a channel while in several, `messages` merges every channel (each labelled `channel`) and `channels` holds the per-channel rest. */
  read(limit: number, before?: string, channel?: string, filter?: ReadFilter): Promise<ReadResult & { channels?: ({ channel: string; roomId: string; error?: KhalaErrorCode; delegated?: true } & Partial<Omit<ReadResult, 'messages'>>)[] }>;
  send(text: string, channel?: string): Promise<{ eventId: string }>;
  /** Hosted only. Validates, encrypts and uploads the image at `file` (an absolute path), then posts it with an optional caption. */
  sendImage(file: string, caption: string, channel?: string): Promise<{ eventId: string }>;
  /** Hosted only. Decrypts an image message to a file under this channel's state dir. The image is untrusted content. */
  downloadImage(eventId: string, channel?: string): Promise<ImageDownload>;
  /** A claim on a key someone else holds is not posted (or loses the race) and returns ClaimConflict. */
  sendChannelEvent(content: ChannelEventContent, channel?: string): Promise<{ eventId: string } | ClaimConflict>;
  /** `reason` posts a visible "<you> left: <reason>" event before leaving. */
  leave(channel: string, reason?: string): Promise<{ left: string; channels: string[] }>;
  /** Agent-initiated listening mode change; `self` may only lower attention. Posts a visible channel event. */
  setMode(mode: ListeningMode, input: SetModeInput, channel?: string): Promise<{ channel: string; previous: ListeningMode; mode: ListeningMode; notice?: 'failed' }>;
  close(): Promise<void>;
}

export type ImageDownload = { path: string; name: string; mimetype: string; w: number; h: number; caption?: string };
export type SetModeInput = { trigger: 'owner_request' | 'self'; reason: string; keepBacklog?: boolean };
export type ChannelStatus = { channel: string; roomId?: string; link?: string; state: string; detail?: string; you?: string; agentUserId?: string; unread: number; listeningMode: ListeningMode; archived?: true; delegated?: true; members?: MemberPresence[] };
export type ReadResult = { you?: string; members?: MemberPresence[]; messages: (InboxEntry & { seenBy?: string[]; channel?: string })[]; nextBefore?: string; wakeNotice?: string } & Partial<CoordinationState>;

export type KhalaErrorCode = 'update_required' | 'channel_required' | 'channel_unknown' | 'channel_ambiguous' | 'channel_limit' | 'invalid_link' | 'link_unavailable' | 'join_expired' | 'not_connected' | 'send_failed' | 'session_unknown' | 'secret_detected' | 'mode_refused' | 'invalid_image' | 'internal_error';
export class KhalaClientError extends Error {
  readonly code: KhalaErrorCode;
  constructor(code: KhalaErrorCode, message?: string, readonly extra?: { channels?: { channel: string; roomId: string }[]; kind?: string; reason?: string }) {
    super(message ?? code);
    this.name = 'KhalaClientError';
    this.code = code;
  }
}
