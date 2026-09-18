// Reconciliation of the protocol and endpoint boundaries. Device removal, session rotation
// and the endpoint's acknowledgment are observed on their own. A lost response is resolved
// by reading status, never by assuming that the removal happened.

import type { CallOptions, DeviceId, RevocationSubject } from '@khala/contracts/messaging/index';
import { type OperationRecord, type ProtocolRefusal, removalSettled, sameSubject } from './operation';

/**
 * - `removed`: the substrate removed the device, or it was already absent.
 * - `replaced`: a different device key is registered under the device ID. Nothing was removed.
 * - `refused`: the substrate declined, for example because it needs interactive re-authentication.
 * - `outcome_unknown`: the request may have landed. The caller reads status before believing either answer.
 * - `unavailable`: nothing was done.
 */
export type DeviceRemovalResult =
  | Readonly<{ kind: 'removed' | 'replaced' }>
  | Readonly<{ kind: 'refused'; reason: ProtocolRefusal }>
  | Readonly<{ kind: 'outcome_unknown' }>
  | Readonly<{ kind: 'unavailable' }>;

/** `present` means the device ID is still registered with the expected key. */
export type DeviceStatusResult = Readonly<{ kind: 'removed' | 'present' | 'replaced' | 'unavailable' }>;

/** Rotation is idempotent, so a lost response is simply asked again. */
export type SessionRotationResult = Readonly<{ kind: 'rotated' | 'outcome_unknown' | 'unavailable' }>;

type ProtocolInput = Readonly<{ operationId: string; deviceId: DeviceId; deviceKey: string }>;

/**
 * Messaging substrate operations, supplied by the selected SDK adapter. Each is idempotent per
 * operation ID. None of them erases anything the device already holds.
 *
 * Device identity is the key, not the ID. `removeDevice` removes the device ID only while it is
 * registered with `deviceKey`, and it answers `replaced` otherwise. A generation or re-initialisation
 * of the same key is therefore still removed, and a new key under a reused ID never is.
 *
 * Removal does not stop a device from decrypting a session it was already given. Only
 * `rotateSessions` excludes it from future events: it discards every outbound session that the
 * adapter's senders shared with `deviceKey`, so the next send starts a session shared only with
 * the devices still allowed.
 *
 * Ordering: from the first protocol call for an operation until `rotateSessions` for that
 * operation returns `rotated`, the adapter sends nothing on an outbound session shared with
 * `deviceKey`. A send in an affected room waits for the rotation. A `refused` removal changed
 * nothing, so it lifts the hold until the next attempt.
 */
export interface ProtocolRevocationPort {
  removeDevice(input: ProtocolInput, options?: CallOptions): Promise<DeviceRemovalResult>;
  deviceStatus(input: ProtocolInput, options?: CallOptions): Promise<DeviceStatusResult>;
  rotateSessions(input: ProtocolInput, options?: CallOptions): Promise<SessionRotationResult>;
}

function protocolInput(record: OperationRecord): ProtocolInput {
  return { operationId: record.operationId, deviceId: record.deviceId, deviceKey: record.deviceKey };
}

/**
 * Advances removal by at most one removal request. Returns the record unchanged when nothing can
 * be learned. Only an operation whose control disable has landed is touched.
 */
export async function reconcileRemoval(
  record: OperationRecord,
  protocol: ProtocolRevocationPort,
  options?: CallOptions,
): Promise<OperationRecord> {
  if (record.control !== 'disabled' || removalSettled(record)) return record;
  const input = protocolInput(record);
  if (record.removal === 'unknown') {
    const status = await protocol.deviceStatus(input, options);
    if (status.kind === 'removed') return withRemoval(record, 'removed', null);
    if (status.kind === 'replaced') return withRemoval(record, 'superseded', null);
    if (status.kind === 'unavailable') return record;
  }
  const result = await protocol.removeDevice(input, options);
  switch (result.kind) {
    case 'removed':
      return withRemoval(record, 'removed', null);
    case 'replaced':
      return withRemoval(record, 'superseded', null);
    case 'refused':
      return withRemoval(record, 'refused', result.reason);
    case 'unavailable':
      return record;
    case 'outcome_unknown': {
      const status = await protocol.deviceStatus(input, options);
      if (status.kind === 'removed') return withRemoval(record, 'removed', null);
      if (status.kind === 'replaced') return withRemoval(record, 'superseded', null);
      // A device that is still present has not been removed yet, so asking again is safe.
      return withRemoval(record, status.kind === 'present' ? 'pending' : 'unknown', null);
    }
  }
}

/** Rotates once removal has settled. Returns the record unchanged until the adapter confirms. */
export async function reconcileRotation(
  record: OperationRecord,
  protocol: ProtocolRevocationPort,
  options?: CallOptions,
): Promise<OperationRecord> {
  if (record.control !== 'disabled' || !removalSettled(record) || record.rotation === 'rotated') return record;
  const result = await protocol.rotateSessions(protocolInput(record), options);
  return result.kind === 'rotated' ? { ...record, rotation: 'rotated' } : record;
}

function withRemoval(
  record: OperationRecord,
  removal: 'pending' | 'unknown' | 'removed' | 'refused' | 'superseded',
  removalRefusal: ProtocolRefusal | null,
): OperationRecord {
  return { ...record, removal, removalRefusal };
}

/**
 * An endpoint's report that it stopped using the revoked authority. The generation must be the
 * generation that the operation moves the target to. A callback from an earlier generation, or
 * one for a replacement target, therefore cannot complete this operation.
 */
export type EndpointAcknowledgment = RevocationSubject & Readonly<{
  operationId: string;
  generation: number;
}>;

/** `ignored` is final: that acknowledgment can never apply to the operation. */
export type AcknowledgmentOutcome = 'recorded' | 'duplicate' | 'ignored';

/** `early`: the acknowledgment matches, but the disable is not journaled yet, so it can apply later. */
export function applyAcknowledgment(
  record: OperationRecord,
  ack: EndpointAcknowledgment,
): Readonly<{ outcome: AcknowledgmentOutcome | 'early'; record: OperationRecord }> {
  if (ack.operationId !== record.operationId || !sameSubject(record, ack) || ack.generation !== record.revokedGeneration
    || record.control === 'stale') return { outcome: 'ignored', record };
  if (record.control === 'pending') return { outcome: 'early', record };
  if (record.endpoint === 'acknowledged') return { outcome: 'duplicate', record };
  return { outcome: 'recorded', record: { ...record, endpoint: 'acknowledged' } };
}
