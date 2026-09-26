import type { Readable, Writable } from 'node:stream';
import type {
  BindingId, EventRef, HarnessCapabilities, ListeningMode, SessionBinding,
} from '@khala/contracts/delivery/index';
import type { InternalRuntime } from '@khala/contracts/internal/command';
import type { AgentListeningModeApplication } from '../composition/listening-mode.js';
import type { ChannelListingPort } from './channels/types.js';
import type { BatchInbox } from './inbox.js';

export const CLI_ERROR_CODES = [
  'invalid_arguments', 'invalid_link', 'invalid_input', 'not_connected', 'binding_not_held',
  'listener_busy', 'storage_failed', 'transport_unavailable', 'outcome_unknown', 'internal_error',
  'internal_unavailable',
] as const;
export type CliErrorCode = (typeof CLI_ERROR_CODES)[number];

// Mirrors the connector bootstrap BLOCKED_CODES without importing its runtime implementation.
export const CONNECT_REFUSAL_CODES = [
  'invalid_request', 'invalid_link', 'untrusted_origin', 'link_unavailable', 'unsupported_descriptor',
  'harness_session_missing', 'unsupported_harness', 'ownership_required', 'admission_denied',
  'binding_conflict', 'binding_revoked', 'operation_conflict', 'device_unavailable',
] as const;
export type ConnectRefusalCode = (typeof CONNECT_REFUSAL_CODES)[number];
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
/** The held binding's effective listening mode; `effective` is null when no mode is currently usable. */
export type AgentListeningModeStatus = Readonly<{
  v: 1; bindingId: BindingId; generation: number; effective: ListeningMode | null;
}>;
export interface AgentClientPort {
  connect(link: string, signal?: AbortSignal): Promise<ConnectResult>;
  send(input: Readonly<{ bindingId: BindingId | null; clientTxnId: string; body: string }>, signal?: AbortSignal): Promise<SendResult>;
  status(signal?: AbortSignal): Promise<AgentStatus>;
  /** Absent until live composition supplies the listening-mode store; native hooks then deliver nothing. */
  listeningMode?(signal?: AbortSignal): Promise<AgentListeningModeStatus>;
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
}>;
/** One CLI subcommand. Adding a command is one file exporting this plus one line in `registry.ts`. */
export type CliCommand = Readonly<{
  name: string;
  run(args: readonly string[], deps: CliDependencies): Promise<number>;
}>;
