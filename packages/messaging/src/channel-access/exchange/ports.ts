// Trusted ports behind the connector-only grant exchange. None of them is reachable
// from an agent, CLI, or MCP surface; composition supplies each one in-process.

import type {
  AuthorizedChannelRef,
  CallOptions,
  ChannelAccessAuthorization,
  DeviceId,
  OwnerId,
  StableAgentPrincipal,
} from '@khala/contracts/messaging/index';

/** Authenticated connector facts that the validated request does not carry. */
export type GrantExchangeConnector = Readonly<{
  /** Stable verified-session fingerprint from connector authentication. */
  sessionFingerprint: string;
}>;

export type GrantExchangeAuthorityInput = Readonly<{
  operationId: string;
  requester: StableAgentPrincipal;
  origin: string;
  sessionGeneration: number;
  sessionFingerprint: string;
  /** Stable per exchange, so every recheck reuses the same idempotent claim. */
  claimOperationId: string;
}>;

export type GrantExchangeAuthorityResult =
  | Readonly<{ kind: 'authorized'; authorization: ChannelAccessAuthorization }>
  /** Terminal: denied, revoked, deleted, visibility lost, or already finished. */
  | Readonly<{ kind: 'closed'; reason: 'expired' | 'closed' }>
  /** Not approved yet, or authority could not be proven now. Retry the same operation. */
  | Readonly<{ kind: 'unavailable' }>;

/**
 * Journal-backed approval authority. `authorize` must recheck the persisted
 * deadline, request revision, current owner, channel visibility/existence, and
 * requester revocation on every call; the exchange calls it immediately before
 * admission and again immediately before minting.
 */
export interface GrantExchangeAuthorityPort {
  authorize(input: GrantExchangeAuthorityInput, options?: CallOptions): Promise<GrantExchangeAuthorityResult>;
  /** Records that the provider refused admission. It never reports `connected`. */
  close(
    input: Readonly<{ authorization: ChannelAccessAuthorization; operationId: string }>,
    options?: CallOptions,
  ): Promise<'closed' | 'unavailable'>;
  /**
   * Moves the requester's journal row to `connected`. Called only for a sealed
   * exchange whose connector acknowledged local activation; idempotent per
   * `readyOperationId`, and `connected` again when the row already is.
   */
  markConnected(
    input: GrantExchangeAuthorityInput & Readonly<{ readyOperationId: string }>,
    options?: CallOptions,
  ): Promise<'connected' | 'closed' | 'unavailable'>;
}

export type ChannelAdmissionRequest = Readonly<{
  /** Recorded durably before the first invocation and reused for every retry. */
  providerOperationId: string;
  ownerId: OwnerId;
  channelRef: AuthorizedChannelRef;
  requester: StableAgentPrincipal;
  sessionGeneration: number;
  deviceId: DeviceId;
  history: 'none';
}>;

export type ChannelAdmissionMembership = 'joined' | 'already_joined';

export type ChannelAdmissionResult =
  | Readonly<{ kind: 'admitted'; membership: ChannelAdmissionMembership }>
  | Readonly<{ kind: 'rejected' }>
  | Readonly<{ kind: 'outcome_unknown' }>
  | Readonly<{ kind: 'unavailable' }>;

export type ChannelAdmissionReconciliation =
  | ChannelAdmissionResult
  /** Proof that the provider never applied this operation. */
  | Readonly<{ kind: 'not_applied' }>;

/** Provider admission, idempotent per `providerOperationId`. */
export interface ChannelAdmissionProviderPort {
  admit(input: ChannelAdmissionRequest, options?: CallOptions): Promise<ChannelAdmissionResult>;
  reconcile(input: ChannelAdmissionRequest, options?: CallOptions): Promise<ChannelAdmissionReconciliation>;
}

export type GrantBinding = Readonly<{
  operationId: string;
  requester: StableAgentPrincipal;
  origin: string;
  sessionGeneration: number;
  deviceId: DeviceId;
  proofKeyThumbprint: string;
  ownerId: OwnerId;
  channelRef: AuthorizedChannelRef;
}>;

/**
 * Mints a one-time grant bound to one exchange. The plaintext is returned once,
 * sealed immediately, and never persisted or logged; the issuer keeps only a hash.
 */
export interface GrantIssuerPort {
  mint(
    input: Readonly<{ binding: GrantBinding; expiresAt: string }>,
    options?: CallOptions,
  ): Promise<Readonly<{ kind: 'minted'; grant: string }> | Readonly<{ kind: 'unavailable' }>>;
}
