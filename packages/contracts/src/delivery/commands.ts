// Owner approval and future-policy command contracts. Browser JSON may decode to
// a command, but never to OwnerAuthority: trusted composition constructs authority
// only after authenticating the owner session.

import {
  type Decoded, type DeliveryLimits, array, booleanValue, decodeWith, elementField, fail, literal, nullable, object,
  safeInteger, utcTimestamp, version,
} from './decode';
import { type EventRef, readEventSelection, sameEventRef } from './events';
import {
  type AuthorizationId, type BindingId, type CommandId, type OperationId, type OwnerId, type ParticipantId,
  type ReleaseId, type RoomId, readId,
} from './ids';

/**
 * Proof of authenticated owner authority supplied by trusted composition. This is
 * deliberately a type-only contract: there is no `decodeOwnerAuthority` because
 * untrusted JSON cannot establish authority by having the right shape.
 */
export type OwnerAuthority = Readonly<{
  ownerId: OwnerId;
  issuer: string;
  subject: string;
  authenticatedAt: string;
  authorizationId: AuthorizationId;
}>;

/** Exact immutable event selection approved for one binding generation. */
export type ApprovalCommand = Readonly<{
  v: 1;
  commandId: CommandId;
  roomId: RoomId;
  bindingId: BindingId;
  expectedPolicyVersion: number;
  expectedBindingGeneration: number;
  selection: readonly EventRef[];
  /** Audit data only; not authorization or replay protection. */
  issuedAt: string;
}>;

/**
 * A future-event policy request. It carries no pending selection, so changing to
 * `auto` cannot implicitly release an existing backlog.
 *
 * `mode: 'auto'` is gated by G-AUTOMATION: this contract selects no default mode,
 * and no implementation may accept `auto` before that gate is decided at launch.
 * It is decodable only so the wire shape need not change when the gate opens.
 */
export type PolicySetCommand = Readonly<{
  v: 1;
  commandId: CommandId;
  roomId: RoomId;
  bindingId: BindingId;
  peerParticipantId: ParticipantId;
  expectedPolicyVersion: number;
  expectedBindingGeneration: number;
  mode: (typeof POLICY_MODES)[number];
  paused: boolean;
  /** Audit data only; not authorization or replay protection. */
  issuedAt: string;
}>;

const POLICY_MODES = ['review', 'auto'] as const;
const CONNECTOR_STATES = ['pending', 'effective', 'offline', 'rejected'] as const;
const POLICY_ACK_ERRORS = [
  'forbidden', 'stale_policy', 'stale_binding', 'idempotency_conflict', 'unavailable', 'outcome_unknown',
] as const;

export type PolicyAckErrorCode = (typeof POLICY_ACK_ERRORS)[number];

/**
 * Requested and effective versions remain independent. Null means no authoritative
 * revision was observed and must never be coerced to zero or the requested value.
 */
export type PolicyAck = Readonly<{
  v: 1;
  commandId: CommandId;
  bindingId: BindingId;
  generation: number;
  requestedVersion: number | null;
  effectiveVersion: number | null;
  connectorState: (typeof CONNECTOR_STATES)[number];
  errorCode: PolicyAckErrorCode | null;
}>;

const DEFINITIVE_APPROVAL_ERRORS = [
  'forbidden', 'stale_policy', 'stale_content', 'stale_binding', 'expired_content', 'idempotency_conflict',
  'unavailable',
] as const;

type DefinitiveApprovalErrorCode = (typeof DEFINITIVE_APPROVAL_ERRORS)[number];

export type ApprovalErrorCode = DefinitiveApprovalErrorCode | 'outcome_unknown';

export type ApprovalResult =
  | Readonly<{ ok: true; releaseIds: readonly ReleaseId[] }>
  | Readonly<{ ok: false; code: DefinitiveApprovalErrorCode }>
  | Readonly<{ ok: false; code: 'outcome_unknown'; operationId: OperationId }>;

export interface ApprovalPort {
  approve(authority: OwnerAuthority, command: ApprovalCommand): Promise<ApprovalResult>;
  setPolicy(authority: OwnerAuthority, command: PolicySetCommand): Promise<PolicyAck>;
}

/**
 * Decodes an approval outcome crossing into the browser. A success lists at least
 * one release; `outcome_unknown` keeps the operation identity for reconciliation.
 */
export function decodeApprovalResult(input: unknown, limits: DeliveryLimits): Decoded<ApprovalResult> {
  return decodeWith((): ApprovalResult => {
    const record = input as { ok?: unknown; code?: unknown } | null;
    if (typeof record === 'object' && record !== null && record.ok === true) {
      const r = object(input, '', ['ok', 'releaseIds']);
      const values = array(r.field('releaseIds'), r.at('releaseIds'));
      if (values.length === 0) fail(r.at('releaseIds'), 'invalid_field');
      if (values.length > limits.maxSelectionEvents) fail(r.at('releaseIds'), 'limit_exceeded');
      const releaseIds = values.map((value, index) => readId<'ReleaseId'>(value, elementField(r.at('releaseIds'), index)));
      if (new Set(releaseIds).size !== releaseIds.length) fail(r.at('releaseIds'), 'invalid_field');
      return { ok: true, releaseIds };
    }
    if (typeof record === 'object' && record !== null && record.code === 'outcome_unknown') {
      const r = object(input, '', ['ok', 'code', 'operationId']);
      literal(r.field('ok'), r.at('ok'), [false]);
      return {
        ok: false,
        code: 'outcome_unknown',
        operationId: readId<'OperationId'>(r.field('operationId'), r.at('operationId')),
      };
    }
    const r = object(input, '', ['ok', 'code']);
    literal(r.field('ok'), r.at('ok'), [false]);
    return { ok: false, code: literal(r.field('code'), r.at('code'), DEFINITIVE_APPROVAL_ERRORS) };
  });
}

export function decodeApprovalCommand(input: unknown, limits: DeliveryLimits): Decoded<ApprovalCommand> {
  return decodeWith(() => {
    const r = object(input, '', [
      'v', 'commandId', 'roomId', 'bindingId', 'expectedPolicyVersion', 'expectedBindingGeneration', 'selection',
      'issuedAt',
    ]);
    const v = version(r.field('v'), r.at('v'));
    const commandId = readId<'CommandId'>(r.field('commandId'), r.at('commandId'));
    const roomId = readId<'RoomId'>(r.field('roomId'), r.at('roomId'));
    const bindingId = readId<'BindingId'>(r.field('bindingId'), r.at('bindingId'));
    const expectedPolicyVersion = safeInteger(r.field('expectedPolicyVersion'), r.at('expectedPolicyVersion'));
    const expectedBindingGeneration = safeInteger(
      r.field('expectedBindingGeneration'),
      r.at('expectedBindingGeneration'),
    );
    const selection = readEventSelection(r.field('selection'), r.at('selection'), limits);
    if (selection[0]!.roomId !== roomId) fail(`${r.at('selection')}[0].roomId`, 'invalid_field');
    return {
      v,
      commandId,
      roomId,
      bindingId,
      expectedPolicyVersion,
      expectedBindingGeneration,
      selection,
      issuedAt: utcTimestamp(r.field('issuedAt'), r.at('issuedAt')),
    };
  });
}

export function decodePolicySetCommand(input: unknown): Decoded<PolicySetCommand> {
  return decodeWith(() => {
    const r = object(input, '', [
      'v', 'commandId', 'roomId', 'bindingId', 'peerParticipantId', 'expectedPolicyVersion',
      'expectedBindingGeneration', 'mode', 'paused', 'issuedAt',
    ]);
    return {
      v: version(r.field('v'), r.at('v')),
      commandId: readId<'CommandId'>(r.field('commandId'), r.at('commandId')),
      roomId: readId<'RoomId'>(r.field('roomId'), r.at('roomId')),
      bindingId: readId<'BindingId'>(r.field('bindingId'), r.at('bindingId')),
      peerParticipantId: readId<'ParticipantId'>(r.field('peerParticipantId'), r.at('peerParticipantId')),
      expectedPolicyVersion: safeInteger(r.field('expectedPolicyVersion'), r.at('expectedPolicyVersion')),
      expectedBindingGeneration: safeInteger(r.field('expectedBindingGeneration'), r.at('expectedBindingGeneration')),
      mode: literal(r.field('mode'), r.at('mode'), POLICY_MODES),
      paused: booleanValue(r.field('paused'), r.at('paused')),
      issuedAt: utcTimestamp(r.field('issuedAt'), r.at('issuedAt')),
    };
  });
}

export function decodePolicyAck(input: unknown): Decoded<PolicyAck> {
  return decodeWith(() => {
    const r = object(input, '', [
      'v', 'commandId', 'bindingId', 'generation', 'requestedVersion', 'effectiveVersion', 'connectorState',
      'errorCode',
    ]);
    const ack: PolicyAck = {
      v: version(r.field('v'), r.at('v')),
      commandId: readId<'CommandId'>(r.field('commandId'), r.at('commandId')),
      bindingId: readId<'BindingId'>(r.field('bindingId'), r.at('bindingId')),
      generation: safeInteger(r.field('generation'), r.at('generation')),
      requestedVersion: nullable(r.field('requestedVersion'), value => safeInteger(value, r.at('requestedVersion'))),
      effectiveVersion: nullable(r.field('effectiveVersion'), value => safeInteger(value, r.at('effectiveVersion'))),
      connectorState: literal(r.field('connectorState'), r.at('connectorState'), CONNECTOR_STATES),
      errorCode: nullable(r.field('errorCode'), value => literal(value, r.at('errorCode'), POLICY_ACK_ERRORS)),
    };

    if (ack.connectorState === 'effective') {
      if (ack.requestedVersion === null) fail(r.at('requestedVersion'), 'invalid_field');
      if (ack.effectiveVersion === null || ack.effectiveVersion !== ack.requestedVersion) {
        fail(r.at('effectiveVersion'), 'invalid_field');
      }
      if (ack.errorCode !== null) fail(r.at('errorCode'), 'invalid_field');
    }
    if (ack.connectorState === 'rejected' && ack.errorCode === null) fail(r.at('errorCode'), 'invalid_field');

    return ack;
  });
}

/** Exact command input equality for an idempotency journal; selection order matters. */
export function sameApprovalCommandInput(a: ApprovalCommand, b: ApprovalCommand): boolean {
  return a.v === b.v
    && a.commandId === b.commandId
    && a.roomId === b.roomId
    && a.bindingId === b.bindingId
    && a.expectedPolicyVersion === b.expectedPolicyVersion
    && a.expectedBindingGeneration === b.expectedBindingGeneration
    && a.issuedAt === b.issuedAt
    && a.selection.length === b.selection.length
    && a.selection.every((ref, index) => sameEventRef(ref, b.selection[index]!));
}

/** Exact command input equality for an idempotency journal. */
export function samePolicySetCommandInput(a: PolicySetCommand, b: PolicySetCommand): boolean {
  return a.v === b.v
    && a.commandId === b.commandId
    && a.roomId === b.roomId
    && a.bindingId === b.bindingId
    && a.peerParticipantId === b.peerParticipantId
    && a.expectedPolicyVersion === b.expectedPolicyVersion
    && a.expectedBindingGeneration === b.expectedBindingGeneration
    && a.mode === b.mode
    && a.paused === b.paused
    && a.issuedAt === b.issuedAt;
}
