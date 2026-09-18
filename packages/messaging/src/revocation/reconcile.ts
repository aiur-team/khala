// Reconciliation of the protocol and endpoint boundaries. Removal of a device and the
// endpoint's acknowledgment are observed on their own. A lost response is resolved by
// reading status, never by assuming that the removal happened.

import type { CallOptions, DeviceId, RevocationSubject } from '@khala/contracts/messaging/index';
import { type OperationRecord, type ProtocolRefusal, sameSubject } from './operation';

/**
 * - `removed`: the substrate removed the device, or it was already absent.
 * - `refused`: the substrate declined, for example because it needs interactive re-authentication.
 * - `outcome_unknown`: the request may have landed. The caller reads status before believing either answer.
 * - `unavailable`: nothing was done.
 */
export type DeviceRemovalResult =
  | Readonly<{ kind: 'removed' }>
  | Readonly<{ kind: 'refused'; reason: ProtocolRefusal }>
  | Readonly<{ kind: 'outcome_unknown' }>
  | Readonly<{ kind: 'unavailable' }>;

export type DeviceStatusResult = Readonly<{ kind: 'removed' | 'present' | 'unavailable' }>;

/**
 * Messaging substrate operations, supplied by the selected SDK adapter. Removal must be
 * idempotent per operation ID. Removing a device excludes it from future key sharing only
 * as far as the SDK's sharing policy goes. It erases nothing the device already holds.
 */
export interface ProtocolRevocationPort {
  removeDevice(input: Readonly<{ operationId: string; deviceId: DeviceId }>, options?: CallOptions): Promise<DeviceRemovalResult>;
  deviceStatus(deviceId: DeviceId, options?: CallOptions): Promise<DeviceStatusResult>;
}

/**
 * Advances the protocol boundary by at most one removal request. The caller has already checked
 * that the target is still at its revoked generation. Returns the record unchanged
 * when nothing can be learned. Only a device whose control disable has landed is touched.
 */
export async function reconcileProtocol(
  record: OperationRecord,
  protocol: ProtocolRevocationPort,
  options?: CallOptions,
): Promise<OperationRecord> {
  if (record.targetKind !== 'device' || record.control !== 'disabled') return record;
  if (record.protocol === 'confirmed' || record.protocol === 'not_applicable' || record.protocol === 'superseded') return record;
  const deviceId = record.targetId;
  if (record.protocol === 'unknown') {
    const status = await protocol.deviceStatus(deviceId, options);
    if (status.kind === 'removed') return withProtocol(record, 'confirmed', null);
    if (status.kind === 'unavailable') return record;
  }
  const result = await protocol.removeDevice({ operationId: record.operationId, deviceId }, options);
  switch (result.kind) {
    case 'removed':
      return withProtocol(record, 'confirmed', null);
    case 'refused':
      return withProtocol(record, 'refused', result.reason);
    case 'unavailable':
      return record;
    case 'outcome_unknown': {
      const status = await protocol.deviceStatus(deviceId, options);
      if (status.kind === 'removed') return withProtocol(record, 'confirmed', null);
      // A device that is still present has not been removed yet, so asking again is safe.
      return withProtocol(record, status.kind === 'present' ? 'pending' : 'unknown', null);
    }
  }
}

function withProtocol(record: OperationRecord, protocol: 'pending' | 'unknown' | 'confirmed' | 'refused', protocolRefusal: ProtocolRefusal | null): OperationRecord {
  return { ...record, protocol, protocolRefusal };
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
