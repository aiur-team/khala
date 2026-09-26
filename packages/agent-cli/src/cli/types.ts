import type { Readable, Writable } from 'node:stream';
import type {
  BindingId, EventRef, HarnessCapabilities, ListeningMode, SessionBinding,
} from '@khala/contracts/delivery/index';
import type { InternalRuntime } from '@khala/contracts/internal/command';
import type { AccessRequestOutcome } from '@khala/contracts/messaging/discovery';
import type { AgentListeningModeApplication } from '../composition/listening-mode.js';
import type { ChannelCreatePort } from './channels/create/types.js';
import type { ChannelAccessPort, ChannelListingPort } from './channels/types.js';
import type { ClaudeSessionClient } from '../composition/claude-session-http.js';
import type { InternalDelivery } from '../composition/internal-delivery.js';
import type { BatchInbox } from './inbox.js';
import type { SetupService } from '../setup/plan.js';

export const CLI_ERROR_CODES = [
  'invalid_arguments', 'invalid_link', 'invalid_input', 'not_connected', 'binding_not_held',
  'listener_busy', 'storage_failed', 'transport_unavailable', 'outcome_unknown', 'internal_error',
  'internal_unavailable', 'discovery_required',
] as const;
export type CliErrorCode = (typeof CLI_ERROR_CODES)[number];

// Mirrors the connector bootstrap BLOCKED_CODES without importing its runtime implementation.
export const CONNECT_REFUSAL_CODES = [
  'invalid_request', 'invalid_link', 'untrusted_origin', 'link_unavailable', 'unsupported_descriptor',
  'harness_session_missing', 'unsupported_harness', 'ownership_required', 'admission_denied',
  'binding_conflict', 'binding_revoked', 'operation_conflict', 'device_unavailable',
] as const;
export type ConnectRefusalCode = (typeof CONNECT_REFUSAL_CODES)[number];
// Code-only pairing refusals: the connector bootstrap codes a pairing can reach.
// None of them says whether a code or channel exists.
export const PAIR_REFUSAL_CODES = [
  'invalid_request', 'untrusted_origin', 'link_unavailable', 'unsupported_descriptor', 'harness_session_missing',
  'unsupported_harness', 'ownership_required', 'admission_denied', 'binding_conflict', 'binding_revoked',
  'operation_conflict', 'device_unavailable', 'pairing_refused', 'pairing_denied', 'pairing_expired', 'rate_limited',
] as const;
export type PairRefusalCode = (typeof PAIR_REFUSAL_CODES)[number];
export type PairResult =
  | Readonly<{ kind: 'connected'; binding: SessionBinding; reused: boolean }>
  | Readonly<{ kind: 'refused'; code: PairRefusalCode }>
  /** The owner has not decided yet; pairing again with the same code resumes the same claim. */
  | Readonly<{ kind: 'pending'; reason: 'approval_timeout' | 'cancelled' }>
  | Readonly<{ kind: 'unavailable' }>;
export const SEND_REFUSAL_CODES = [
  'invalid_input', 'not_connected', 'binding_not_held', 'storage_failed', 'transport_unavailable',
] as const;
export type SendRefusalCode = (typeof SEND_REFUSAL_CODES)[number];

// The CLI reports contract `unsupported` as `unavailable`: both fail closed, while
// `unavailable` describes the installed component before live composition exists.
type AgentRouteFromContract<Route extends string> = Route extends 'unsupported' ? 'unavailable' : Route;
export type AgentRoute = AgentRouteFromContract<HarnessCapabilities['existingSession']>;
const AGENT_ROUTE_MEMBERS = {
  unknown: true,
  unavailable: true,
  khala_hosted_resume: true,
  native_cli_queue: true,
  agent_installed_listener: true,
  opencode_plugin: true,
  native_hooks: true,
} as const satisfies Record<AgentRoute, true>;
export const AGENT_ROUTES = Object.freeze(Object.keys(AGENT_ROUTE_MEMBERS)) as readonly AgentRoute[];

export type ConnectResult =
  | Readonly<{ kind: 'connected'; binding: SessionBinding; reused: boolean }>
  | Readonly<{ kind: 'refused'; code: ConnectRefusalCode }>
  | Readonly<{ kind: 'unavailable' }>;
export type SendResult =
  | Readonly<{ kind: 'accepted'; clientTxnId: string; eventId: string | null }>
  | Readonly<{ kind: 'refused'; code: SendRefusalCode; clientTxnId: string }>
  | Readonly<{ kind: 'outcome_unknown'; clientTxnId: string }>;
export type AgentStatus = Readonly<{
  v: 1; connected: boolean; binding: SessionBinding | null; route: AgentRoute; sourceCursor: string | null;
}>;
export type AccessRequestResult =
  | Readonly<{ kind: 'status'; outcome: AccessRequestOutcome }>
  | Readonly<{ kind: 'refused'; code: 'invalid_link' | 'discovery_required' }>
  | Readonly<{ kind: 'unavailable' }>;
/** The held binding's effective listening mode; `effective` is null when no mode is currently usable. */
export type AgentListeningModeStatus = Readonly<{
  v: 1; bindingId: BindingId; generation: number; effective: ListeningMode | null;
}>;
export interface AgentClientPort {
  connect(link: string, signal?: AbortSignal): Promise<ConnectResult>;
  /** Present only on a descriptor-backed local client; asks the channel-access journal for a human grant. */
  requestAccess?(channelUrl: string, signal?: AbortSignal): Promise<AccessRequestResult>;
  /** Present only when the connector is configured for code-only pairing with a hosted origin. */
  pair?(code: string, signal?: AbortSignal): Promise<PairResult>;
  send(input: Readonly<{ bindingId: BindingId | null; clientTxnId: string; body: string }>, signal?: AbortSignal): Promise<SendResult>;
  status(signal?: AbortSignal): Promise<AgentStatus>;
  /** Absent until live composition supplies the listening-mode store; native hooks then deliver nothing. */
  listeningMode?(signal?: AbortSignal): Promise<AgentListeningModeStatus>;
  /** How a binding this client holds records a harness's own session ID; absent means verbatim. */
  storedSessionId?(harness: string, sessionId: string): string;
  /** Present only on a descriptor-backed local client: `mode get/set` for the binding its descriptor holds. */
  listeningModeControl?: AgentListeningModeApplication;
  /** Absent until composition supplies the discovery-credentialed access client; both operations then report `unavailable`. */
  requestChannelAccess?: ChannelAccessPort['requestChannelAccess'];
  channelAccessStatus?: ChannelAccessPort['channelAccessStatus'];
  /** Absent until composition supplies a create-capable client; both operations then report `unavailable`. */
  requestChannelCreate?: ChannelCreatePort['requestChannelCreate'];
  channelCreateStatus?: ChannelCreatePort['channelCreateStatus'];
  listChannels: ChannelListingPort['listChannels'];
  listAgents: ChannelListingPort['listAgents'];
}
export type InboxDelivery = Readonly<{
  v: 1; releaseId: string; bindingId: BindingId; generation: number; events: readonly EventRef[];
  payloadDigest: string; payload: Uint8Array; receivedAt: string;
}>;
export type InboxRecord = Readonly<{
  v: 1; releaseId: string; bindingId: BindingId; generation: number; events: readonly EventRef[];
  payloadDigest: string; payloadBase64: string; receivedAt: string;
}>;
export type InboxCursor = Readonly<{ v: 1; offset: number; releaseId: string | null }>;
/** Lazily loads the application-owned `khala internal` runtime; called only for that command. */
export type InternalRuntimeLoader = () => Promise<InternalRuntime>;

export type CliDependencies = Readonly<{
  client: AgentClientPort;
  inbox: (bindingId: string, generation: number) => Promise<BatchInbox>;
  /** Pre-bound to the held binding by trusted composition; absent or null means no mode control is composed. */
  listeningMode?: AgentListeningModeApplication | null;
  stdin: Readable; stdout: Writable; stderr: Writable; signal?: AbortSignal;
  internal?: InternalRuntimeLoader; env?: Readonly<Record<string, string | undefined>>; cwd?: string;
  /** Lazily composes the descriptor-backed local client; called only when `--internal-descriptor` or `defaultDescriptorPath` selects it. */
  internalClient?: (descriptorPath: string) => Promise<AgentClientPort>;
  /** Lazily composes delivery of local-server releases into the held binding's inbox, with `--internal-descriptor`. */
  internalDelivery?: (descriptorPath: string) => Promise<InternalDelivery>;
  /** The stable `active.json` the installed Codex/OpenCode `mcp-serve` entry and `codex-hook` re-read when argv names no descriptor. */
  defaultDescriptorPath?: string;
  claude?: ClaudeSessionClient;
  /** Setup planning and configuration status. The production composition always supplies it. */
  setup?: SetupService;
}>;
/** One CLI subcommand. Adding a command is one file exporting this plus one line in `registry.ts`. */
export type CliCommand = Readonly<{
  name: string;
  run(args: readonly string[], deps: CliDependencies): Promise<number>;
}>;
