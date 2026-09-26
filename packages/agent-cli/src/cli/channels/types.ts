import type { BindingId } from '@khala/contracts/delivery/index';
import type { ChannelListing } from '@khala/contracts/messaging/index';

export const CHANNEL_LIST_REFUSAL_CODES = [
  'untrusted_origin', 'discovery_required', 'discovery_denied', 'cursor_unavailable', 'rate_limited',
] as const;
export type ChannelListRefusalCode = (typeof CHANNEL_LIST_REFUSAL_CODES)[number];

export const MAX_CHANNEL_AGENTS = 100;
export const MAX_AGENT_DISPLAY_NAME_BYTES = 256;
export const AGENT_CONNECTIONS = ['connected', 'stale', 'offline', 'unknown'] as const;
export type AgentConnection = (typeof AGENT_CONNECTIONS)[number];

/** One joined agent. Display names are owner- or agent-supplied untrusted data. */
export type ChannelAgent = Readonly<{
  v: 1; participantId: string; displayName: string; ownerDisplayName: string; connection: AgentConnection;
}>;
export type ChannelAgentRoster = Readonly<{ v: 1; agents: readonly ChannelAgent[] }>;

// Port results carry `unknown` payloads on purpose: the listing service decodes
// them strictly, so a composition can never widen what the CLI or MCP prints.
export type ChannelListResult =
  | Readonly<{ kind: 'listed'; page: unknown }>
  | Readonly<{ kind: 'refused'; code: ChannelListRefusalCode }>
  | Readonly<{ kind: 'unavailable' }>;
export type AgentListResult =
  | Readonly<{ kind: 'listed'; roster: unknown }>
  /** The server does not hold this binding in any channel; indistinguishable from an unheld binding. */
  | Readonly<{ kind: 'refused'; code: 'not_joined' }>
  | Readonly<{ kind: 'unavailable' }>;

export type ChannelListInput = Readonly<{ origin: string | null; cursor: string | null }>;
export type AgentListInput = Readonly<{ bindingId: BindingId }>;

export type ChannelListingPort = Readonly<{
  listChannels(input: ChannelListInput, signal?: AbortSignal): Promise<ChannelListResult>;
  listAgents(input: AgentListInput, signal?: AbortSignal): Promise<AgentListResult>;
}>;

export type ListingErrorCode = ChannelListRefusalCode | 'not_connected' | 'not_joined' | 'unavailable';
export type ListingFailure = Readonly<{ ok: false; error: ListingErrorCode }>;
/** The exact object printed by `khala channels list` and returned by `khala_list_channels`. */
export type ChannelListOutput =
  | Readonly<{ ok: true; v: 1; items: readonly ChannelListing[]; nextCursor: string | null }>
  | ListingFailure;
/** The exact object printed by `khala agents list` and returned by `khala_list_agents`. */
export type AgentListOutput =
  | Readonly<{ ok: true; v: 1; channel: BindingId; agents: readonly ChannelAgent[] }>
  | ListingFailure;
