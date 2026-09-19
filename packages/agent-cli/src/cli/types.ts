import type { BindingId, EventRef, SessionBinding } from '@khala/contracts/delivery/index';

export const CLI_ERROR_CODES = [
  'invalid_arguments', 'invalid_link', 'invalid_input', 'not_connected', 'binding_not_held',
  'listener_busy', 'storage_failed', 'transport_unavailable', 'outcome_unknown',
] as const;
export type CliErrorCode = (typeof CLI_ERROR_CODES)[number];

export type ConnectResult =
  | Readonly<{ kind: 'connected'; binding: SessionBinding; reused: boolean }>
  | Readonly<{ kind: 'refused'; code: string }>
  | Readonly<{ kind: 'unavailable' }>;
export type SendResult =
  | Readonly<{ kind: 'accepted'; clientTxnId: string; eventId: string | null }>
  | Readonly<{ kind: 'refused'; code: string; clientTxnId: string }>
  | Readonly<{ kind: 'outcome_unknown'; clientTxnId: string }>;
export type AgentStatus = Readonly<{
  v: 1; connected: boolean; binding: SessionBinding | null; route: string; sourceCursor: string | null;
}>;
export interface AgentClientPort {
  connect(link: string): Promise<ConnectResult>;
  send(input: Readonly<{ bindingId: BindingId | null; clientTxnId: string; body: string }>): Promise<SendResult>;
  status(): Promise<AgentStatus>;
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
