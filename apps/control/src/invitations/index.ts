import type {
  Admission,
  AdmissionPolicy,
  AdmissionPort,
  AdmissionRejection,
  AuthPrincipal,
  CallOptions,
  ControlStore,
  DeviceId,
  IdentityPort,
  InviteState,
  OperationResult,
  RoomId,
  RoomSummary,
  ShareGrant,
  TrustedClock,
} from '@khala/contracts/messaging/index';
import { admitInvite } from './admit';
import { inspectInvite } from './inspect';
import { type Digests, createDigests, validateOrigin } from './internal';
import type { AdmissionHistory } from './policy';
import { revokeInvite, shareInvite } from './share';

export type ShareInput = Readonly<{
  operationId: string;
  roomId: RoomId;
  policy: AdmissionPolicy;
}>;

export interface InvitationAuthority {
  canShare(
    input: Readonly<{ principal: AuthPrincipal; roomId: RoomId }>,
    options?: CallOptions,
  ): Promise<'allowed' | 'forbidden' | 'unavailable'>;
}

export type GatewayAdmission =
  | Readonly<{ kind: 'joined'; room: RoomSummary; historyReady: boolean }>
  | Readonly<{ kind: 'unavailable' }>
  | Readonly<{ kind: 'outcome_unknown' }>
  | Readonly<{ kind: 'forbidden' }>;

export type GatewayLookup =
  | Readonly<{ kind: 'joined'; room: RoomSummary; historyReady: boolean }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'unavailable' }>
  | Readonly<{ kind: 'outcome_unknown' }>;

export type GatewayInspection =
  | Readonly<{ kind: 'joined'; historyReady: boolean }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'unavailable' }>;

export type GatewayRequest = Readonly<{
  operationId: string;
  roomId: RoomId;
  principal: AuthPrincipal;
  deviceId: DeviceId;
  history: AdmissionHistory;
  inviteRevision: string;
}>;

/** Provider boundary: membership and key/history disclosure share one idempotent operation identity. */
export interface AdmissionGateway {
  inspectMembership(
    input: Readonly<{ roomId: RoomId; principal: AuthPrincipal; history: AdmissionHistory }>,
    options?: CallOptions,
  ): Promise<GatewayInspection>;
  admit(input: GatewayRequest, options?: CallOptions): Promise<GatewayAdmission>;
  lookup(input: GatewayRequest, options?: CallOptions): Promise<GatewayLookup>;
}

export type AdmissionServiceOptions = Readonly<{
  store: ControlStore;
  identity: IdentityPort;
  authority: InvitationAuthority;
  gateway: AdmissionGateway;
  clock: TrustedClock;
  origin: string;
  allowedOrigins: readonly string[];
  /** Deployment secret for purpose-separated HMACs. At least 32 bytes. */
  secret: string | Uint8Array;
  /** Business expiry retained in the record so inspection can distinguish it from revocation. */
  inviteLifetimeMs: number | null;
}>;

export type AdmissionRuntime = AdmissionServiceOptions & Readonly<{ origin: string; digests: Digests }>;

export interface AdmissionService extends AdmissionPort {
  share(input: ShareInput, options?: CallOptions): Promise<OperationResult<ShareGrant, AdmissionRejection>>;
  revoke(
    input: Readonly<{ operationId: string; inviteRef: string }>,
    options?: CallOptions,
  ): Promise<OperationResult<null, AdmissionRejection>>;
}

export function createAdmissionService(options: AdmissionServiceOptions): AdmissionService {
  if (options.inviteLifetimeMs !== null && (!Number.isSafeInteger(options.inviteLifetimeMs) || options.inviteLifetimeMs <= 0)) {
    throw new Error('inviteLifetimeMs must be a positive safe integer or null');
  }
  const runtime: AdmissionRuntime = {
    ...options,
    origin: validateOrigin(options.origin, options.allowedOrigins),
    digests: createDigests(options.secret),
  };
  return {
    share: (input, callOptions) => shareInvite(runtime, input, callOptions),
    inspect: (inviteRef: string, callOptions?: CallOptions): Promise<InviteState> => inspectInvite(runtime, inviteRef, callOptions),
    admit: (
      input: Readonly<{ operationId: string; inviteRef: string; deviceId: DeviceId }>,
      callOptions?: CallOptions,
    ): Promise<OperationResult<Admission, AdmissionRejection>> => admitInvite(runtime, input, callOptions),
    revoke: (input, callOptions) => revokeInvite(runtime, input, callOptions),
  };
}

export {
  type AdmissionHistory,
} from './policy';
export type { AdmissionPolicy } from '@khala/contracts/messaging/index';
