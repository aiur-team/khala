import type {
  CallOptions,
  DeviceId,
  DeviceView,
  Disposer,
  IdentityState,
  OperationResult,
  OwnerId,
  ProvideRecoverySecret,
  RecoveryCapabilities,
  RecoveryPort,
  RevocationPort,
  RevocationSubject,
  RoomId,
} from '@khala/contracts/messaging/index';

export type HistoryAvailability = 'available' | 'partial' | 'unavailable';
export type RecoveryConnection = 'online' | 'offline' | 'unknown';

export type RevocationCapability = RevocationSubject & Readonly<{
  expectedGeneration: number;
}>;

export const CLOSURE_UNAVAILABLE_REASONS = [
  'not_configured',
  'forbidden',
  'stale_room',
  'signed_out',
] as const;

export type ClosureUnavailableReason = (typeof CLOSURE_UNAVAILABLE_REASONS)[number];

export const CLOSURE_FAILURE_REASONS = [
  'forbidden',
  'stale_room',
  'dependency_unavailable',
  'local_cleanup_failed',
] as const;

export type ClosureFailureReason = (typeof CLOSURE_FAILURE_REASONS)[number];

/** The fixed, operator-approved no-deletion-promise consequence set. */
export type ClosureConsequences = Readonly<{
  stopsNewMessages: true;
  removesFromOwnerView: true;
  requestsLocalCleanup: true;
  recallsDeliveredCopies: false;
}>;

export type ClosureCapability =
  | Readonly<{
    ownerId: OwnerId;
    roomId: RoomId;
    expectedRoomRevision: number;
    available: true;
    unavailableReason: null;
    consequences: ClosureConsequences;
  }>
  | Readonly<{
    ownerId: OwnerId;
    roomId: RoomId;
    expectedRoomRevision: number;
    available: false;
    unavailableReason: ClosureUnavailableReason;
    consequences: ClosureConsequences;
  }>;

export type ClosureRequest = Readonly<{
  operationId: string;
  ownerId: OwnerId;
  roomId: RoomId;
  expectedRoomRevision: number;
}>;

export type ClosureStatus = Readonly<{
  operationId: string;
  state: 'pending' | 'complete' | 'partial' | 'failed';
  reason: ClosureFailureReason | null;
}>;

export type ClosureRejection = 'forbidden' | 'stale_room' | 'operation_mismatch';

/**
 * One authoritative read of independent authentication, device, history and
 * capability facts. Connectivity is display context only: it never upgrades
 * partial or unavailable history.
 */
export type RecoverySnapshot = Readonly<{
  identity: IdentityState;
  device: DeviceView;
  history: HistoryAvailability;
  connection: RecoveryConnection;
  recovery: RecoveryCapabilities;
  revocationTargets: readonly RevocationCapability[];
  closure: ClosureCapability | null;
}>;

/** Non-secret write-ahead identity used to inspect an interrupted operation. */
export type RecoveryOperationReference = Readonly<{
  kind: 'recovery' | 'revocation' | 'closure';
  operationId: string;
  ownerId: OwnerId;
  deviceId: DeviceId | null;
  deviceGeneration: number;
  roomId: RoomId;
  roomRevision: number;
}>;

export interface RecoveryResumeStore {
  load(): RecoveryOperationReference | null;
  save(reference: RecoveryOperationReference): void;
  clear(): void;
}

/**
 * Browser-only facade. Recovery and revocation keep the canonical KHA-105
 * signatures; closure is a feature-local seam that KHA-136 will adapt.
 */
export interface RecoveryUiPort {
  snapshot(): RecoverySnapshot;
  subscribe(listener: () => void, signal: AbortSignal): Disposer;
  beginRecovery(
    input: Parameters<RecoveryPort['begin']>[0],
    provideSecret: ProvideRecoverySecret,
    options?: CallOptions,
  ): ReturnType<RecoveryPort['begin']>;
  inspectRecovery(operationId: string, options?: CallOptions): ReturnType<RecoveryPort['inspect']>;
  revoke(input: Parameters<RevocationPort['revoke']>[0], options?: CallOptions): ReturnType<RevocationPort['revoke']>;
  inspectRevocation(operationId: string, options?: CallOptions): ReturnType<RevocationPort['inspect']>;
  closeRoom(
    input: ClosureRequest,
    options?: CallOptions,
  ): Promise<OperationResult<ClosureStatus, ClosureRejection>>;
  inspectClosure(
    operationId: string,
    options?: CallOptions,
  ): Promise<OperationResult<ClosureStatus, 'not_found'>>;
}

export interface RecoveryPorts {
  readonly ui: RecoveryUiPort;
  readonly resumeStore: RecoveryResumeStore;
}
