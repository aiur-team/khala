// Durable revocation operation record. Each boundary is tracked on its own, so that
// Khala's control disable, the agent's adapter capability, the messaging device removal,
// the outbound session rotation and the endpoint's acknowledgment are never reported as a
// single "revoked" flag.

import type {
  BindingId, DeviceId, JsonValue, OwnerId, RevocationProgress, RevocationRequest, RevocationSubject,
} from '@khala/contracts/messaging/index';

/** `disabled`: Khala refuses new release and dispatch for the target. `stale`: the target moved on first. */
export type ControlBoundary = 'pending' | 'disabled' | 'stale';

/**
 * The agent's adapter capability for a binding: every adapter token issued for it. `revoked`
 * means none of them is accepted any more. A device has no adapter capability.
 */
export type CapabilityBoundary = 'not_applicable' | 'pending' | 'revoked';

/**
 * Removal of the messaging device: the target device, or the agent's own device for a binding.
 *
 * - `pending`: not yet requested, or proven not to have landed. Retrying is safe.
 * - `unknown`: requested, but the response was lost and status could not be read.
 * - `removed`: the substrate no longer lists the device.
 * - `refused`: the substrate refused. A human must act, for example by re-authenticating.
 * - `superseded`: a different device key now holds the device ID. That replacement has its
 *   own authority, so this operation never removes it and cannot confirm the removal itself.
 */
export type RemovalBoundary = 'pending' | 'unknown' | 'removed' | 'refused' | 'superseded';

export type ProtocolRefusal = 'reauthentication_required' | 'forbidden';

/**
 * Rotation of every outbound session shared with the device key. Removal alone does not
 * exclude a device from a session it already holds, so a device is excluded from future
 * events only once this is `rotated`.
 */
export type RotationBoundary = 'pending' | 'rotated';

/** Only an acknowledgment from the endpoint proves it stopped. An offline endpoint stays `pending`. */
export type EndpointBoundary = 'pending' | 'acknowledged';

/** Operation state from the plan: `requested → local_disabled → protocol_pending → completed | partial | failed`. */
export type OperationState = 'requested' | 'local_disabled' | 'protocol_pending' | 'completed' | 'partial' | 'failed';

/**
 * Limits of what revocation can achieve. These are always reported, because no revocation
 * recalls what an endpoint has already received. Deletion and history promises are still
 * open under G-RETENTION.
 */
export type RevocationLimitation =
  | 'disclosed_content_not_recalled'
  | 'retained_keys_not_recalled'
  | 'other_devices_unaffected'
  | 'account_and_membership_unchanged';

export type OperationRecord = RevocationSubject & Readonly<{
  v: 2;
  operationId: string;
  ownerId: OwnerId;
  expectedGeneration: number;
  /** Generation the target moves to. Callbacks that carry any other generation are ignored. */
  revokedGeneration: number;
  /** Messaging device this operation excludes, and its identity key, both captured with the intent. */
  deviceId: DeviceId;
  deviceKey: string;
  control: ControlBoundary;
  capability: CapabilityBoundary;
  removal: RemovalBoundary;
  removalRefusal: ProtocolRefusal | null;
  rotation: RotationBoundary;
  endpoint: EndpointBoundary;
  /** Count of journal writes for this operation. Each write gets its own store operation ID. */
  seq: number;
}>;

/** Public detail for UI and composition consumers. It never contains message content or key material. */
export type RevocationStatus = RevocationSubject & Readonly<{
  operationId: string;
  state: OperationState;
  generation: number;
  deviceId: DeviceId;
  control: ControlBoundary;
  capability: CapabilityBoundary;
  removal: RemovalBoundary;
  removalRefusal: ProtocolRefusal | null;
  rotation: RotationBoundary;
  endpoint: EndpointBoundary;
  /**
   * True while resubmitting the same request could still move a boundary forward. A `partial`
   * operation that waits only on an endpoint's acknowledgment is not retryable, but it is still pending.
   */
  retryable: boolean;
  limitations: readonly RevocationLimitation[];
}>;

export type ExcludedDevice = Readonly<{ deviceId: DeviceId; deviceKey: string }>;

export function newOperation(ownerId: OwnerId, request: RevocationRequest, device: ExcludedDevice): OperationRecord {
  return {
    v: 2,
    operationId: request.operationId,
    ownerId,
    ...subjectOf(request),
    expectedGeneration: request.expectedGeneration,
    revokedGeneration: request.expectedGeneration + 1,
    deviceId: device.deviceId,
    deviceKey: device.deviceKey,
    control: 'pending',
    capability: request.targetKind === 'binding' ? 'pending' : 'not_applicable',
    removal: 'pending',
    removalRefusal: null,
    rotation: 'pending',
    endpoint: 'pending',
    seq: 0,
  };
}

export function subjectOf(subject: RevocationSubject): RevocationSubject {
  return subject.targetKind === 'device'
    ? { targetKind: 'device', targetId: subject.targetId }
    : { targetKind: 'binding', targetId: subject.targetId };
}

export function sameSubject(a: RevocationSubject, b: RevocationSubject): boolean {
  return a.targetKind === b.targetKind && a.targetId === b.targetId;
}

/** True when `request` asks for exactly the intent recorded under its operation ID. */
export function sameIntent(record: OperationRecord, ownerId: OwnerId, request: RevocationRequest): boolean {
  return record.ownerId === ownerId && sameSubject(record, request) && record.expectedGeneration === request.expectedGeneration;
}

/** Removal reached an end state from which the sessions can be rotated. */
export function removalSettled(record: OperationRecord): boolean {
  return record.removal === 'removed' || record.removal === 'superseded';
}

export function operationState(record: OperationRecord): OperationState {
  if (record.control === 'stale') return 'failed';
  if (record.control === 'pending') return 'requested';
  if (record.capability === 'pending' || record.removal === 'pending') return 'local_disabled';
  if (record.removal === 'unknown' || (removalSettled(record) && record.rotation === 'pending')) return 'protocol_pending';
  // Removing the agent from its rooms is a separate capability, so a binding never completes here.
  if (record.removal !== 'removed' || record.endpoint === 'pending' || record.targetKind === 'binding') return 'partial';
  return 'completed';
}

/** True while resubmitting the request could move a boundary. An endpoint's acknowledgment is not something `revoke` can do. */
function canRetry(record: OperationRecord): boolean {
  if (record.control === 'pending') return true;
  if (record.control !== 'disabled') return false;
  return record.capability === 'pending'
    || ['pending', 'unknown', 'refused'].includes(record.removal)
    || (removalSettled(record) && record.rotation === 'pending');
}

/** Compact, injective code of the boundary fields. It makes each journal write ID name its content. */
export function boundaryCode(record: OperationRecord): string {
  return [record.control, record.capability, record.removal, record.removalRefusal ?? 'none', record.rotation, record.endpoint].join('.');
}

/**
 * Maps onto the contract's coarser states. `partial` means some effects landed and the rest
 * are waiting on something this service cannot do by itself: an offline endpoint's
 * acknowledgment, a human answering a protocol refusal, or room-membership removal.
 *
 * A `failed` operation has no progress: it was refused before any effect, and it never
 * became a revocation.
 */
export function toProgress(record: OperationRecord): RevocationProgress | null {
  const state = operationState(record);
  if (state === 'failed') return null;
  return {
    operationId: record.operationId,
    ...subjectOf(record),
    generation: record.revokedGeneration,
    state: state === 'requested' ? 'pending'
      : state === 'completed' ? 'complete'
        : state === 'partial' ? 'partial'
          : 'propagating',
  };
}

export function limitationsOf(subject: RevocationSubject): readonly RevocationLimitation[] {
  return subject.targetKind === 'device'
    ? ['disclosed_content_not_recalled', 'retained_keys_not_recalled', 'other_devices_unaffected']
    : ['disclosed_content_not_recalled', 'retained_keys_not_recalled', 'account_and_membership_unchanged'];
}

export function toStatus(record: OperationRecord): RevocationStatus {
  return {
    operationId: record.operationId,
    ...subjectOf(record),
    state: operationState(record),
    generation: record.revokedGeneration,
    deviceId: record.deviceId,
    control: record.control,
    capability: record.capability,
    removal: record.removal,
    removalRefusal: record.removalRefusal,
    rotation: record.rotation,
    endpoint: record.endpoint,
    retryable: canRetry(record),
    limitations: limitationsOf(record),
  };
}

export function encodeOperation(record: OperationRecord): JsonValue {
  return { ...record };
}

const CONTROL: readonly ControlBoundary[] = ['pending', 'disabled', 'stale'];
const CAPABILITY: readonly CapabilityBoundary[] = ['not_applicable', 'pending', 'revoked'];
const REMOVAL: readonly RemovalBoundary[] = ['pending', 'unknown', 'removed', 'refused', 'superseded'];
const REFUSALS: readonly ProtocolRefusal[] = ['reauthentication_required', 'forbidden'];
const ROTATION: readonly RotationBoundary[] = ['pending', 'rotated'];
const ENDPOINT: readonly EndpointBoundary[] = ['pending', 'acknowledged'];
const FIELDS = [
  'v', 'operationId', 'ownerId', 'targetKind', 'targetId', 'expectedGeneration', 'revokedGeneration', 'deviceId',
  'deviceKey', 'control', 'capability', 'removal', 'removalRefusal', 'rotation', 'endpoint', 'seq',
];

/**
 * Reads a journal value strictly. A record this module did not write, or wrote under an
 * older shape, is `null`: the service treats it as unusable rather than guessing.
 */
export function decodeOperation(value: JsonValue): OperationRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const r = value as { readonly [key: string]: JsonValue };
  const keys = Object.keys(r);
  if (keys.length !== FIELDS.length || !FIELDS.every(key => Object.hasOwn(r, key))) return null;
  const text = (key: string) => (typeof r[key] === 'string' && r[key] !== '' ? r[key] : null);
  const count = (key: string) => (Number.isSafeInteger(r[key]) && (r[key] as number) >= 0 ? r[key] as number : null);
  const oneOf = <T extends string>(key: string, allowed: readonly T[]) => (allowed.includes(r[key] as T) ? r[key] as T : null);
  const operationId = text('operationId');
  const ownerId = text('ownerId');
  const targetId = text('targetId');
  const deviceId = text('deviceId');
  const deviceKey = text('deviceKey');
  const targetKind = oneOf('targetKind', ['device', 'binding'] as const);
  const expectedGeneration = count('expectedGeneration');
  const revokedGeneration = count('revokedGeneration');
  const control = oneOf('control', CONTROL);
  const capability = oneOf('capability', CAPABILITY);
  const removal = oneOf('removal', REMOVAL);
  const rotation = oneOf('rotation', ROTATION);
  const endpoint = oneOf('endpoint', ENDPOINT);
  const seq = count('seq');
  const removalRefusal = r.removalRefusal === null ? null : oneOf('removalRefusal', REFUSALS);
  if (r.v !== 2 || operationId === null || ownerId === null || targetId === null || targetKind === null
    || deviceId === null || deviceKey === null || (targetKind === 'device' && deviceId !== targetId)
    || expectedGeneration === null || revokedGeneration !== expectedGeneration + 1
    || control === null || capability === null || removal === null || rotation === null || endpoint === null || seq === null
    || (r.removalRefusal !== null && removalRefusal === null)
    || (removal === 'refused') !== (removalRefusal !== null)
    || (rotation === 'rotated' && removal !== 'removed' && removal !== 'superseded')
    || (targetKind === 'binding') === (capability === 'not_applicable')) return null;
  const subject: RevocationSubject = targetKind === 'device'
    ? { targetKind, targetId: targetId as DeviceId }
    : { targetKind, targetId: targetId as BindingId };
  return {
    v: 2, operationId, ownerId: ownerId as OwnerId, ...subject, expectedGeneration, revokedGeneration,
    deviceId: deviceId as DeviceId, deviceKey, control, capability, removal, removalRefusal, rotation, endpoint, seq,
  };
}
