import type { ListeningMode } from '@khala/contracts/m1/listening-mode';
import type { AgentCredentials } from '@khala/contracts/m1/agent-join';

export type SessionMessage = { eventId: string; roomId: string; sender: string; ts: number; type: 'm.room.message' | 'com.khala.event.v1'; body: string; content: Record<string, unknown> };
export type SessionModeCommand = { eventId: string; roomId: string; sender: string; ts: number; content: unknown };
export interface ChannelSession {
  readonly userId: string;
  inviter(roomId: string): string | undefined;
  onListeningModeCommand(handler: (c: SessionModeCommand) => void): () => void;
  publishListeningMode(roomId: string, mode: ListeningMode, signal?: AbortSignal): Promise<void>;
  onMessage(handler: (m: SessionMessage) => void): () => void;
  waitForInvite(roomId: string, timeoutMs: number): Promise<void>;
  join(roomId: string): Promise<void>;
  history(roomId: string, limit: number, before?: string): Promise<{ messages: SessionMessage[]; nextBefore?: string }>;
  send(roomId: string, text: string): Promise<{ eventId: string }>;
  sendChannelEvent(roomId: string, content: Record<string, unknown>, txnId?: string): Promise<{ eventId: string }>;
  roomName(roomId: string): string | undefined;
  displayName(userId: string): string | undefined;
  stop(): Promise<void>;
}

export type StartSession = (creds: AgentCredentials) => Promise<ChannelSession>;
export const startChannelSession: StartSession = async creds => creds.transport === 'local'
  ? (await import('./local/session')).createLocalSession(creds)
  : (await import('./matrix/session')).createAgentMatrixSession(creds);
