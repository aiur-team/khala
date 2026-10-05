import type { NameError } from '@khala/contracts/m1/names';
import type { AcknowledgementSupport, ReceiptKindV2 } from '@khala/contracts/delivery/index';
import type { OwnerId, ParticipantId, RoomId } from '@khala/contracts/messaging/ids';

export type AgentConnectionState = 'connected' | 'stale' | 'offline' | 'unknown';

export type AgentPresenceReceipt = Readonly<{
  kind: ReceiptKindV2;
  observedAt: string;
}>;

export type AgentPresence = Readonly<{
  participantId: ParticipantId;
  /** Server-attested owner binding; absent on older status sources, which cannot authorize edits. */
  ownerId?: OwnerId;
  displayName: string;
  ownerDisplayName: string;
  /** Current state after composition applies subscription liveness and receipt evidence, including bounded stale expiry. */
  connection: AgentConnectionState;
  /** Human-readable capability copy, including honest values such as "Unsupported". */
  routeLabel: string;
  lastReceipt: AgentPresenceReceipt | null;
  /** The route's closed batch-token capability, carried unchanged from the connector snapshot. */
  acknowledgement: AcknowledgementSupport;
}>;

export type AgentPresenceSnapshot = Readonly<{
  generation: number;
  agents: readonly AgentPresence[];
}>;

/**
 * Browser-facing presence facade. KHA-153 supplies the live implementation;
 * this feature only consumes generation-tagged snapshots and copyable commands.
 */
export interface ChannelUiPort {
  agents(roomId: RoomId, signal: AbortSignal): Promise<AgentPresenceSnapshot>;
  subscribeAgents(roomId: RoomId, listener: (snapshot: AgentPresenceSnapshot) => void): () => void;
  installCommand(participantId: ParticipantId, signal: AbortSignal): Promise<string>;
}

/** @deprecated Use `ChannelUiPort`. Kept through the first tagged release containing #163. */
export type RoomUiPort = ChannelUiPort;

export interface AgentNamesPort {
  /** `roomId` keeps the name unique in that channel where the backend supports it. */
  rename(matrixUserId: string, name: string, signal?: AbortSignal, roomId?: RoomId):
    Promise<{ kind: 'ok'; name: string } | {
      kind: 'error';
      code: 'invalid_name' | 'name_taken' | 'not_owner' | 'not_found' | 'signed_out' | 'unavailable';
      reason?: NameError;
    }>;
}

export type ChannelNameResult = { kind: 'ok'; name: string } | {
  kind: 'error';
  code: 'invalid_name' | 'name_taken' | 'signed_out' | 'unavailable';
  reason?: NameError;
};

/**
 * The viewer's own name in one channel. Usernames are not unique across Khala,
 * so a human who meets someone with the same name picks another for that channel.
 * There is no subject: no one can set another member's name through it.
 */
export interface ChannelNamesPort {
  setOwnName(roomId: RoomId, name: string, signal?: AbortSignal): Promise<ChannelNameResult>;
}
