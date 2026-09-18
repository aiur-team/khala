// Durable revocation operation record. Each boundary is tracked on its own, so that
// Khala's control disable, the messaging protocol effect and the endpoint's
// acknowledgment are never reported as a single "revoked" flag.

import type {
  BindingId, DeviceId, JsonValue, OwnerId, RevocationProgress, RevocationRequest, RevocationSubject,
} from '@khala/contracts/messaging/index';

/** `disabled`: Khala refuses new release and dispatch for the target. `stale`: the target moved on first. */
export type ControlBoundary = 'pending' | 'disabled' | 'stale';

/**
 * The protocol effect is the SDK removal of a device, which excludes it from future key
 * sharing. It is `not_applicable` to a binding: revoking a binding changes neither the
 * messaging account nor room membership.
 *
 * - `pending`: not yet requested, or proven not to have landed. Retrying is safe.
 * - `unknown`: requested, but the response was lost and status could not be read.
 * - `refused`: the substrate refused. A human must act, for example by re-authenticating.
 */
export type ProtocolBoundary = 'not_applicable' | 'pending' | 'unknown' | 'confirmed' | 'refused';

export type ProtocolRefusal = 'reauthentication_required' | 'forbidden';

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
  | 'device_keys_unchanged'
  | 'account_and_membership_unchanged';

export type OperationRecord = RevocationSubject & Readonly<{
  v: 1;
  operationId: string;
  ownerId: OwnerId;
  expectedGeneration: number;
  /** Generation the target moves to. Callbacks that carry any other generation are ignored. */
  revokedGeneration: number;
  control: ControlBoundary;
  protocol: ProtocolBoundary;
  protocolRefusal: ProtocolRefusal | null;
  endpoint: EndpointBoundary;
  /** Count of journal writes for this operation. Each write gets its own store operation ID. */
  seq: number;
}>;

/** Public detail for UI and composition consumers. It never contains message content or key material. */
export type RevocationStatus = RevocationSubject & Readonly<{
  operationId: string;
  state: OperationState;
  generation: number;
  control: ControlBoundary;
  protocol: ProtocolBoundary;
  protocolRefusal: ProtocolRefusal | null;
  endpoint: EndpointBoundary;
  /** True while resubmitting the same request could still move a boundary forward. */
  retryable: boolean;
  limitations: readonly RevocationLimitation[];
}>;

export function newOperation(ownerId: OwnerId, request: RevocationRequest): OperationRecord {
  return {
    v: 1,
    operationId: request.operationId,
    ownerId,
    ...subjectOf(request),
    expectedGeneration: request.expectedGeneration,
    revokedGeneration: request.expectedGeneration + 1,
    control: 'pending',
    protocol: request.targetKind === 'device' ? 'pending' : 'not_applicable',
    protocolRefusal: null,
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

export function operationState(record: OperationRecord): OperationState {
  if (record.control === 'stale') return 'failed';
  if (record.control === 'pending') return 'requested';
  if (record.protocol === 'pending') return 'local_disabled';
  if (record.protocol === 'unknown') return 'protocol_pending';
  if (record.protocol === 'refused' || record.endpoint === 'pending') return 'partial';
  return 'completed';
}

/**
 * Maps onto the contract's coarser states. `partial` means some effects landed and the rest
 * are waiting on something this service cannot do by itself: an offline endpoint's
 * acknowledgment, or a human answering a protocol refusal.
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
    : ['disclosed_content_not_recalled', 'device_keys_unchanged', 'account_and_membership_unchanged'];
}

export function toStatus(record: OperationRecord): RevocationStatus {
  const state = operationState(record);
  return {
    operationId: record.operationId,
    ...subjectOf(record),
    state,
    generation: record.revokedGeneration,
    control: record.control,
    protocol: record.protocol,
    protocolRefusal: record.protocolRefusal,
    endpoint: record.endpoint,
    retryable: state !== 'completed' && state !== 'failed',
    limitations: limitationsOf(record),
  };
}

export function encodeOperation(record: OperationRecord): JsonValue {
  return { ...record };
}

const CONTROL: readonly ControlBoundary[] = ['pending', 'disabled', 'stale'];
const PROTOCOL: readonly ProtocolBoundary[] = ['not_applicable', 'pending', 'unknown', 'confirmed', 'refused'];
const REFUSALS: readonly ProtocolRefusal[] = ['reauthentication_required', 'forbidden'];
const ENDPOINT: readonly EndpointBoundary[] = ['pending', 'acknowledged'];
const FIELDS = [
  'v', 'operationId', 'ownerId', 'targetKind', 'targetId', 'expectedGeneration', 'revokedGeneration',
  'control', 'protocol', 'protocolRefusal', 'endpoint', 'seq',
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
  const targetKind = oneOf('targetKind', ['device', 'binding'] as const);
  const expectedGeneration = count('expectedGeneration');
  const revokedGeneration = count('revokedGeneration');
  const control = oneOf('control', CONTROL);
  const protocol = oneOf('protocol', PROTOCOL);
  const endpoint = oneOf('endpoint', ENDPOINT);
  const seq = count('seq');
  const protocolRefusal = r.protocolRefusal === null ? null : oneOf('protocolRefusal', REFUSALS);
  if (r.v !== 1 || operationId === null || ownerId === null || targetId === null || targetKind === null
    || expectedGeneration === null || revokedGeneration !== expectedGeneration + 1
    || control === null || protocol === null || endpoint === null || seq === null
    || (r.protocolRefusal !== null && protocolRefusal === null)
    || (protocol === 'refused') !== (protocolRefusal !== null)
    || (targetKind === 'binding') !== (protocol === 'not_applicable')) return null;
  const subject: RevocationSubject = targetKind === 'device'
    ? { targetKind, targetId: targetId as DeviceId }
    : { targetKind, targetId: targetId as BindingId };
  return {
    v: 1, operationId, ownerId: ownerId as OwnerId, ...subject, expectedGeneration, revokedGeneration,
    control, protocol, protocolRefusal, endpoint, seq,
  };
}
