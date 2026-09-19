import type { BindingId, EventRef, SessionBinding } from '@khala/contracts/delivery/index';

export const CLI_ERROR_CODES = [
  'invalid_arguments', 'invalid_link', 'invalid_input', 'not_connected', 'binding_not_held',
  'listener_busy', 'storage_failed', 'transport_unavailable', 'outcome_unknown',
] as const;
export type CliErrorCode = (typeof CLI_ERROR_CODES)[number];

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
export const AGENT_ROUTES = [
  'unknown', 'unavailable', 'khala_hosted_resume', 'native_cli_queue', 'agent_installed_listener',
] as const;
export type AgentRoute = (typeof AGENT_ROUTES)[number];

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
export interface AgentClientPort {
  connect(link: string, signal?: AbortSignal): Promise<ConnectResult>;
  send(input: Readonly<{ bindingId: BindingId | null; clientTxnId: string; body: string }>, signal?: AbortSignal): Promise<SendResult>;
  status(signal?: AbortSignal): Promise<AgentStatus>;
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
