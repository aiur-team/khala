import type { AcknowledgementSupport, ReceiptKindV2 } from '@khala/contracts/delivery/index';
import type { ParticipantId, RoomId } from '@khala/contracts/messaging/ids';

export type AgentConnectionState = 'connected' | 'stale' | 'offline' | 'unknown';

export type AgentPresenceReceipt = Readonly<{
  kind: ReceiptKindV2;
  observedAt: string;
}>;

export type AgentPresence = Readonly<{
  participantId: ParticipantId;
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
