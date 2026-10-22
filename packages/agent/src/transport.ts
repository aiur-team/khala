import type { ListeningMode } from '@khala/contracts/m1/listening-mode';
import type { AgentCredentials } from '@khala/contracts/m1/agent-join';

// Bound restart work when a saved intake boundary is unavailable.
export const RESTORE_HISTORY_MAX_PAGES = 20;

export type SessionMessage = { eventId: string; roomId: string; sender: string; ts: number; type: 'm.room.message' | 'com.khala.event.v1' | 'm.room.member'; body: string; content: Record<string, unknown>; previousContent?: Record<string, unknown> };
export type SessionModeCommand = { eventId: string; roomId: string; sender: string; ts: number; content: unknown };
/** `away` carries when the member was last seen alive and, after a clean exit, why it left. */
export type MemberPresence = { name: string; presence: 'online' | 'away' | 'unknown'; since?: string; reason?: string };
export type SessionEndReason ='removed' | 'channel_deleted' | 'unauthorized';
export interface ChannelSession {
  readonly userId: string;
  readonly cryptoReset?: boolean;
  // join() replays missed messages and owner commands through the subscriptions.
  readonly recoversOnJoin?: boolean;
  listeningMode?(roomId: string): ListeningMode;
  onEnded?(handler: (reason: SessionEndReason) => void): () => void;
  inviter(roomId: string): string | undefined;
  onListeningModeCommand(handler: (c: SessionModeCommand) => void): () => void;
  publishListeningMode(roomId: string, mode: ListeningMode, signal?: AbortSignal): Promise<void>;
  onMessage(handler: (m: SessionMessage) => void): () => void;
  waitForInvite(roomId: string, timeoutMs: number): Promise<void>;
  join(roomId: string): Promise<void>;
  joinedAt?(roomId: string): number | undefined;
  history(roomId: string, limit: number, before?: string, options?: { includeUnavailable?: boolean; stopAtEventId?: string }): Promise<{ messages: SessionMessage[]; nextBefore?: string; reachedBoundary?: boolean; oldestTs?: number }>;
  send(roomId: string, text: string): Promise<{ eventId: string }>;
  sendChannelEvent(roomId: string, content: Record<string, unknown>, txnId?: string): Promise<{ eventId: string }>;
  roomName(roomId: string): string | undefined;
  displayName(userId: string): string | undefined;
  // Hosted only; the local helper has no presence or receipts.
  members?(roomId: string): MemberPresence[];
  /** Names of other members whose read receipt (or later message) covers `eventId`. */
  seenBy?(roomId: string, eventId: string): string[];
  markRead?(roomId: string, eventId: string): Promise<void>;
  /** Show the agent away with this reason while it stays connected (a usage limit); undefined returns it online. */
  setAway?(reason: string | undefined): void;
  stop(): Promise<void>;
}

export type SessionOptions = { cryptoStore?: { dir: string; root: string }; restoreStopAtEventId?: string; checkRemoved?: () => Promise<boolean> };
export type StartSession = (creds: AgentCredentials, options?: SessionOptions) => Promise<ChannelSession>;
export const startChannelSession: StartSession = async (creds, options) => creds.transport === 'local'
  ? (await import('./local/session')).createLocalSession(creds)
  : (await import('./matrix/session')).createAgentMatrixSession(creds, options);
