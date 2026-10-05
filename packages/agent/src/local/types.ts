import type { IncomingHttpHeaders } from 'node:http';
import type { AgentCredentials } from '@khala/contracts/m1/agent-join';
import type { LocalChannelSummary, LocalEvent, LocalEventType, LocalHistoryPage, LocalMember, OwnerProfile } from '@khala/contracts/m1/local';
export type LocalRequest = {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'; path: string; query: URLSearchParams; headers: IncomingHttpHeaders;
  body: unknown;                       // parsed JSON (undefined for GET/DELETE or empty body); invalid JSON is rejected by the server with 400 before routing
  auth: LocalAuth; origin: string;     // origin = "http://127.0.0.1:<port>" (the helper's canonical origin)
  signal: AbortSignal;                 // aborted when the client disconnects (long-poll)
};
export type LocalAuth =
  | { kind: 'none' }
  | { kind: 'owner'; via: 'cookie' | 'admin' }
  | { kind: 'agent'; userId: string; roomId: string };
export type LocalResponse =
  | { status: number; json?: unknown; headers?: Record<string, string> }
  | { status: 302; location: string; headers?: Record<string, string> };
export type LocalRoute = { method: LocalRequest['method']; pattern: RegExp; handle(req: LocalRequest, params: string[], ctx: HelperContext): Promise<LocalResponse> };

export interface LocalStore {
  listChannels(): LocalChannelSummary[];                                   // newest activity first
  channelSummary(roomId: string): LocalChannelSummary | undefined;
  createChannel(name: string, operationId?: string): Promise<{ roomId: string; created: boolean }>;   // same operationId → same roomId, created:false
  findByOperation(operationId: string): string | undefined;
  deleteChannel(roomId: string): Promise<void>;
  hasChannel(roomId: string): boolean;
  channelOfMember(userId: string): string | undefined;                     // agent user ids are unique across channels
  revision(): number;                                                      // bumped on every append/create/delete
  waitForRevision(since: number, timeoutMs: number, signal: AbortSignal): Promise<void>;   // resolves when revision() !== since, on timeout, or on abort
  append(roomId: string, input: { type: LocalEventType; sender: string; content: Record<string, unknown>; txnId?: string }): Promise<LocalEvent>;   // dedups (sender, txnId)
  eventsAfter(roomId: string, after: number, limit: number): LocalEvent[];
  waitForEvent(roomId: string, after: number, timeoutMs: number, signal: AbortSignal): Promise<void>;   // resolves when lastSeq > after, on timeout, or on abort
  history(roomId: string, before: string | undefined, limit: number): LocalHistoryPage;
  members(roomId: string): LocalMember[];
  member(roomId: string, userId: string): (Omit<LocalMember, 'membership'> & { membership: 'invite' | 'join' | 'leave' }) | undefined;   // R12
  channelName(roomId: string): string;
  mintLink(roomId: string, kind: 'join'): Promise<{ token: string; expiresAt: string }>;   // returns plaintext once; stores sha256
  consumeLink(token: string): Promise<{ roomId: string } | null>;                           // atomic single use; null if unknown/used/expired
  memberForSession(roomId: string, sessionKey: string): ReturnType<LocalStore['member']>;
  setMemberToken(roomId: string, userId: string, tokenSha256: string | null, sessionKey?: string): Promise<void>;
  agentForToken(token: string): { roomId: string; userId: string } | null;                 // timing-safe compare over sha256
  /** The owner's per-channel name, when one overrides the profile username in `roomId`. */
  ownerChannelName(roomId: string): string | undefined;
  /** Sets, or with `null` clears, the owner's name in one channel; appends the owner's member event when the shown name changes. */
  setOwnerChannelName(roomId: string, name: string | null): Promise<LocalEvent | null>;
  owner(): OwnerProfile;
  setOwner(next: OwnerProfile): Promise<void>;
}
export type HelperContext = { store: LocalStore; origin: string; now(): number; random(bytes: number): Uint8Array; version: string;
  mintOpenToken(roomId?: string): { token: string; expiresAt: string }; consumeOpenToken(token: string): { roomId?: string } | null;   // in memory
  createOwnerSession(): string;   // R12: 43-char id accepted as the khala_local_owner cookie
  shutdown(): void;               // R12: exit 0 after the current response flushes
  joins: Map<string, PendingJoin> };
export type PendingJoin = { joinId: string; pollSecretSha256: string; roomId: string; credentials: AgentCredentials; state: 'confirmed' | 'claimed' | 'ready'; expiresAt: number };
