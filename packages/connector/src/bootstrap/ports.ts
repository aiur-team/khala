// Bootstrap-local dependency interfaces. They wrap KHA-105/106 contracts and
// KHA-115/117/118 implementations, and replace none of them. KHA-133 binds real
// implementations. Every port reports a finite outcome; a port that throws is
// treated as `unavailable` and its message is never propagated.

import type { SessionBinding } from '@khala/contracts/messaging/index';
import type { HarnessCapabilities } from '@khala/contracts/delivery/index';
import type { BootstrapDescriptor, OwnershipMethod } from './descriptor';
import type { DiscoveryPort } from './discovery';

export type { DiscoveryPort } from './discovery';

/**
 * The agent's own claim about the session it is running in. Untrusted until
 * `SessionInspectionPort` verifies the native session behind it.
 */
export type SessionClaim = Readonly<{ harness: string; sessionId: string; workdir: string }>;

/** A native session the harness adapter verified exists, with its current generation. */
export type VerifiedSession = Readonly<{ harness: string; sessionId: string; generation: number }>;

export type SessionInspection =
  | Readonly<{ kind: 'verified'; session: VerifiedSession; capabilities: HarnessCapabilities }>
  /** The harness cannot identify the session: never substitute a fresh one. */
  | Readonly<{ kind: 'missing' }>
  /** No adapter for this harness, or the adapter reports it cannot attach. */
  | Readonly<{ kind: 'unsupported' }>
  | Readonly<{ kind: 'unavailable' }>;

export interface SessionInspectionPort {
  inspect(claim: SessionClaim): Promise<SessionInspection>;
}

/**
 * Proof of the owner's authority for one session and one device, produced by the
 * exact ownership method KHA-144 proved. `secret` is a short-lived,
 * sender-constrained grant. It never enters a result, record or log.
 */
export type OwnershipGrant = Readonly<{
  method: OwnershipMethod;
  /** The descriptor's redeem endpoint, the only place this grant is presented. */
  redeem: string;
  session: VerifiedSession;
  deviceId: string;
  /** Epoch milliseconds, as stated by the issuing service. */
  expiresAt: number;
  secret: string;
}>;

export type OwnershipOutcome =
  | Readonly<{ kind: 'granted'; grant: OwnershipGrant }>
  /** The owner did not complete the ownership step (timed out, declined, not signed in). */
  | Readonly<{ kind: 'refused'; code: 'ownership_required' | 'admission_denied' }>
  | Readonly<{ kind: 'unavailable' }>;

export interface OwnershipPort {
  /** Methods this connector can perform, in preference order. */
  readonly methods: readonly OwnershipMethod[];
  prove(input: Readonly<{
    method: OwnershipMethod;
    descriptor: BootstrapDescriptor;
    session: VerifiedSession;
    deviceId: string;
    operationId: string;
  }>): Promise<OwnershipOutcome>;
}

/** Everything the model-facing adapter may do. It cannot approve, release or set policy. */
export const ADAPTER_CAPABILITIES = ['publish_own', 'receive_released', 'ack_delivery'] as const;
export type AdapterAction = (typeof ADAPTER_CAPABILITIES)[number];

/**
 * The adapter's capability for one binding generation, sender-constrained to the
 * connector key. Revoking the binding invalidates it. `token` is a secret: it never
 * enters a result, record or log.
 */
export type AdapterCapability = Readonly<{
  token: string;
  scope: readonly AdapterAction[];
  bindingId: string;
  generation: number;
  /** Epoch milliseconds, as stated by the issuing service. */
  expiresAt: number;
}>;

export type AdmissionOutcome =
  | Readonly<{ kind: 'admitted'; binding: SessionBinding; capability: AdapterCapability }>
  | Readonly<{ kind: 'refused'; code: 'ownership_required' | 'admission_denied' | 'binding_conflict' | 'binding_revoked' }>
  | Readonly<{ kind: 'unavailable' }>
  /** The service may have admitted; retry with the same operation ID only. */
  | Readonly<{ kind: 'outcome_unknown' }>;

export interface BootstrapAdmissionPort {
  redeem(input: Readonly<{ grant: OwnershipGrant; operationId: string }>): Promise<AdmissionOutcome>;
}

export type DeviceReservation =
  | Readonly<{ kind: 'reserved'; deviceId: string }>
  | Readonly<{ kind: 'unavailable' }>;

export type DeviceActivation =
  | Readonly<{ kind: 'ready' }>
  /** The device exists or may exist but is not usable; it stays reserved for repair. */
  | Readonly<{ kind: 'failed'; reason: 'storage_unavailable' | 'capability_rejected' | 'initialization_failed' }>
  | Readonly<{ kind: 'unavailable' }>;

export type DeviceStatus = 'ready' | 'incomplete' | 'missing' | 'unavailable';

/**
 * The owner connector's own messaging device. Distinct from the human's devices
 * and from the agent participant. `reserve` must return the same device for the
 * same operation, and activating it again must resume rather than mint a new one.
 */
export interface ConnectorDevicePort {
  reserve(operationId: string): Promise<DeviceReservation>;
  activate(input: Readonly<{ deviceId: string; binding: SessionBinding; capability: AdapterCapability; operationId: string }>): Promise<DeviceActivation>;
  status(deviceId: string): Promise<DeviceStatus>;
}

/**
 * Non-secret, recoverable operation state. `phase` records how far the operation
 * got, so a retry resumes instead of repeating a side effect:
 * - `reserved`: a device ID is fixed; nothing was admitted yet.
 * - `admitted`: the service returned `binding` for that device.
 * - `repair_required`: admitted, but the device failed to become ready.
 * - `connected`: the device was ready with `binding`.
 */
export type OperationRecord = Readonly<{
  v: 1;
  operationId: string;
  fingerprint: string;
  phase: 'reserved' | 'admitted' | 'repair_required' | 'connected';
  deviceId: string;
  binding: SessionBinding | null;
}>;

export type OperationRead =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'record'; record: OperationRecord; revision: number }>
  | Readonly<{ kind: 'unavailable' }>;

export type OperationWrite =
  | Readonly<{ kind: 'saved'; revision: number }>
  | Readonly<{ kind: 'conflict' }>
  | Readonly<{ kind: 'unavailable' }>;

/** Durable local operation ledger (KHA-115 storage). Compare-and-set by revision. */
export interface BootstrapOperationStore {
  load(operationId: string): Promise<OperationRead>;
  /** `expectedRevision: null` creates only if absent. */
  save(record: OperationRecord, expectedRevision: number | null): Promise<OperationWrite>;
}

export type BootstrapPorts = Readonly<{
  discovery: DiscoveryPort;
  ownership: OwnershipPort;
  admission: BootstrapAdmissionPort;
  devices: ConnectorDevicePort;
  sessions: SessionInspectionPort;
  operations: BootstrapOperationStore;
  /** Trusted local time in epoch milliseconds. */
  clock?: () => number;
}>;
