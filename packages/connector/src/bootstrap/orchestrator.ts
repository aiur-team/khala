// Agent-operated link bootstrap. The agent hands over the link the human pasted
// and its own session claim. The connector then discovers the service, verifies
// the native session, obtains owner authority through the proven ownership
// method, redeems admission for its own device, and reports one finite result.
// The link grants nothing by itself: owner, participant, device and binding
// identities exist only after verified ownership and admission.
//
// Code-only pairing (`pairing-code-v1`) replaces the link with a human-entered
// code and follows the same state machine: verified inspection, one reserved
// device, owner approval, the same admission checks, then activation.

import { createHash, createHmac } from 'node:crypto';
import { type SessionBinding, decodeSessionBinding, readCanonicalCode, sameSessionBinding } from '@khala/contracts/messaging/index';
import { LINK_OWNERSHIP_METHODS, PAIRING_METHOD, type OwnershipMethod } from './descriptor';
import { sessionEvidenceDigest } from './pairing';
import type {
  BootstrapPorts, OperationRecord, OwnershipGrant, SessionClaim, VerifiedSession,
} from './ports';
import { admitsExistingSessionRoute } from '../route-admission';

type BootstrapInputBase = Readonly<{
  session: SessionClaim;
  /** Caller-chosen and reused on every retry of the same setup. */
  operationId: string;
}>;

export type BootstrapInput = BootstrapInputBase & (
  | Readonly<{ channelUrl: string; chatUrl?: never }>
  /** @deprecated Use `channelUrl`. Kept through the first tagged release containing #163. */
  | Readonly<{ chatUrl: string; channelUrl?: never }>
);

/**
 * Code-only pairing from another machine. The code is a secret for five minutes:
 * it reaches only the claim request and a digest in the operation fingerprint.
 */
export type PairingBootstrapInput = BootstrapInputBase & Readonly<{ pairingCode: string }>;

export type BootstrapOptions = Readonly<{
  /** Cancels a pairing approval wait; the claim stays resumable with the same operation ID. */
  signal?: AbortSignal;
}>;

type NormalizedBootstrapInput = BootstrapInputBase & Readonly<{ channelUrl: string }>;

export const BLOCKED_CODES = [
  'invalid_request',
  'invalid_link',
  'untrusted_origin',
  'link_unavailable',
  'unsupported_descriptor',
  'harness_session_missing',
  'unsupported_harness',
  'ownership_required',
  'admission_denied',
  'binding_conflict',
  'binding_revoked',
  'operation_conflict',
  'device_unavailable',
  // Code-only pairing. None of these says whether a code or channel exists.
  'pairing_refused',
  'pairing_denied',
  'pairing_expired',
  'rate_limited',
] as const;

export type BlockedCode = (typeof BLOCKED_CODES)[number];

export type BootstrapResult =
  | Readonly<{ kind: 'connected'; binding: SessionBinding; reused: boolean }>
  | Readonly<{ kind: 'blocked'; code: BlockedCode }>
  /** Nothing conclusive happened, or the outcome is unknown. Retry with the same `operationId`. */
  | Readonly<{ kind: 'unavailable'; retryable: true; operationId: string }>
  /** A pairing claim is waiting for the owner. Retry with the same `operationId` to keep waiting. */
  | Readonly<{ kind: 'pending'; reason: 'approval_timeout' | 'cancelled'; retryable: true; operationId: string }>;

const OPERATION_ID = /^[A-Za-z0-9_-]{8,64}$/;
const HARNESS = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_FIELD_BYTES = 512;
const MAX_WORKDIR_BYTES = 4096;

/**
 * Stands in for the pairing code inside the persisted fingerprint. A plain SHA-256
 * of a 50-bit code is a precomputable lookup table; keying it with the operation ID
 * makes every record's mark unique, and the code itself is never stored.
 */
function codeMark(pairingCode: string, operationId: string): string {
  return createHmac('sha256', `khala.pairing.code-mark.v1\0${operationId}`).update(pairingCode).digest('base64url');
}

/** Stable digest of everything a retry must repeat exactly. */
export function operationFingerprint(input: BootstrapInput): string {
  const normalized = normalizeInput(input);
  if (normalized === null) throw new TypeError('invalid bootstrap input');
  const { channelUrl, session } = normalized;
  return createHash('sha256')
    .update(JSON.stringify(['khala.bootstrap.v1', channelUrl, session.harness, session.sessionId, session.workdir]))
    .digest('base64url');
}

export async function bootstrapAgent(
  input: BootstrapInput | PairingBootstrapInput,
  ports: BootstrapPorts,
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  if (typeof input === 'object' && input !== null && Object.hasOwn(input, 'pairingCode')) {
    return pairAgent(input as PairingBootstrapInput, ports, options);
  }
  return linkAgent(input as BootstrapInput, ports);
}

async function linkAgent(input: BootstrapInput, ports: BootstrapPorts): Promise<BootstrapResult> {
  const normalized = normalizeInput(input);
  if (!validInput(normalized)) return blocked('invalid_request');
  const { operationId } = normalized;
  const retry: BootstrapResult = { kind: 'unavailable', retryable: true, operationId };
  const clock = ports.clock ?? Date.now;
  const fingerprint = operationFingerprint(normalized);

  const loaded = await guard(() => ports.operations.load(operationId), { kind: 'unavailable' } as const);
  if (loaded.kind === 'unavailable') return retry;
  let record = loaded.kind === 'record' ? loaded.record : null;
  let revision = loaded.kind === 'record' ? loaded.revision : null;
  if (record && (record.fingerprint !== fingerprint || record.operationId !== operationId)) return blocked('operation_conflict');

  // A lost response after success: report the recorded outcome if the device is still ready.
  if (record?.phase === 'connected' && record.binding) {
    const status = await guard(() => ports.devices.status(record!.deviceId), 'unavailable' as const);
    if (status === 'unavailable') return retry;
    if (status === 'ready') return { kind: 'connected', binding: record.binding, reused: true };
  }

  const discovered = await guard(() => ports.discovery.resolve(normalized.channelUrl), { kind: 'unavailable' } as const);
  if (discovered.kind === 'unavailable') return retry;
  if (discovered.kind === 'rejected') return blocked(discovered.code);

  // Verify the native session before any owner-facing step, so an unsupported
  // harness is reported without opening a browser or admitting a device.
  const inspected = await guard(() => ports.sessions.inspect(input.session), { kind: 'unavailable' } as const);
  if (inspected.kind === 'unavailable') return retry;
  if (inspected.kind === 'missing') return blocked('harness_session_missing');
  if (inspected.kind === 'unsupported') return blocked('unsupported_harness');
  const session = inspected.session;
  const { capabilities } = inspected;
  if (session.harness !== normalized.session.harness || session.sessionId !== normalized.session.sessionId
    || !admitsExistingSessionRoute(capabilities, session.harness, ports.allowExperimentalAgentListener ?? false)) {
    return blocked('unsupported_harness');
  }
  // The binding is immutable: a new generation needs the owner's rebinding flow, not a reconnect.
  if (record?.binding && !bindsSession(record.binding, session)) return blocked('binding_conflict');

  // A link offers the link methods only: a descriptor that also lists pairing still uses loopback.
  const method = pickMethod(ports.ownership.methods.filter(m => LINK_OWNERSHIP_METHODS.includes(m)), discovered.descriptor.methods);
  if (method === null) return blocked('ownership_required');

  // Fix the device before anything is admitted, so no retry can mint a second one.
  if (record === null) {
    const reservation = await guard(() => ports.devices.reserve(operationId), { kind: 'unavailable' } as const);
    if (reservation.kind === 'unavailable') return retry;
    const next: OperationRecord = { v: 1, operationId, fingerprint, phase: 'reserved', deviceId: reservation.deviceId, binding: null };
    const saved = await guard(() => ports.operations.save(next, null), { kind: 'unavailable' } as const);
    if (saved.kind !== 'saved') return retry;
    record = next;
    revision = saved.revision;
  }
  const deviceId = record.deviceId;

  const owned = await guard(
    () => ports.ownership.prove({ method, descriptor: discovered.descriptor, session, deviceId, operationId }),
    { kind: 'unavailable' } as const,
  );
  if (owned.kind === 'unavailable') return retry;
  if (owned.kind === 'refused') return blocked(owned.code);
  const { grant } = owned;
  if (grant.method !== method || grant.redeem !== discovered.descriptor.redeem || grant.deviceId !== deviceId || !sameSession(grant.session, session) || !(grant.expiresAt > clock())) {
    return blocked('ownership_required');
  }
  return admit({ grant, session, operationId, record, revision }, ports);
}

/**
 * Code-only pairing. The fingerprint is computed only after the descriptor and
 * the native session are known, so it binds the configured origin, descriptor,
 * code, submitted claim, inspected generation and connector key together.
 */
async function pairAgent(input: PairingBootstrapInput, ports: BootstrapPorts, options: BootstrapOptions): Promise<BootstrapResult> {
  if (!validPairingInput(input)) return blocked('invalid_request');
  const { operationId, pairingCode } = input;
  const retry: BootstrapResult = { kind: 'unavailable', retryable: true, operationId };
  const clock = ports.clock ?? Date.now;
  const { pairing } = ports;
  const resolvePairing = ports.discovery.resolvePairing?.bind(ports.discovery);
  if (pairing === undefined || resolvePairing === undefined) return blocked('ownership_required');

  const loaded = await guard(() => ports.operations.load(operationId), { kind: 'unavailable' } as const);
  if (loaded.kind === 'unavailable') return retry;
  let record = loaded.kind === 'record' ? loaded.record : null;
  let revision = loaded.kind === 'record' ? loaded.revision : null;

  const discovered = await guard(() => resolvePairing(options), { kind: 'unavailable' } as const);
  if (discovered.kind === 'unavailable') return retry;
  if (discovered.kind === 'rejected') return blocked(discovered.code);
  const { descriptor } = discovered;

  // The submitted claim only locates the session. Everything sent onward is what inspection verified.
  const inspected = await guard(() => ports.sessions.inspect(input.session), { kind: 'unavailable' } as const);
  if (inspected.kind === 'unavailable') return retry;
  if (inspected.kind === 'missing') return blocked('harness_session_missing');
  if (inspected.kind === 'unsupported') return blocked('unsupported_harness');
  const session = inspected.session;
  const { capabilities } = inspected;
  if (session.harness !== input.session.harness || session.sessionId !== input.session.sessionId
    || !admitsExistingSessionRoute(capabilities, session.harness, ports.allowExperimentalAgentListener ?? false)) {
    return blocked('unsupported_harness');
  }

  const fingerprint = createHash('sha256').update(JSON.stringify([
    'khala.pairing.bootstrap.v1', discovered.origin, descriptor.id,
    codeMark(pairingCode, operationId),
    input.session.harness, input.session.sessionId, input.session.workdir,
    session.generation, pairing.jkt,
  ])).digest('base64url');
  if (record && (record.fingerprint !== fingerprint || record.operationId !== operationId)) return blocked('operation_conflict');

  if (record?.phase === 'connected' && record.binding) {
    const status = await guard(() => ports.devices.status(record!.deviceId), 'unavailable' as const);
    if (status === 'unavailable') return retry;
    if (status === 'ready') return { kind: 'connected', binding: record.binding, reused: true };
  }
  if (record?.binding && !bindsSession(record.binding, session)) return blocked('binding_conflict');

  // Fix the device before the claim, so the claim names it and no retry can mint a second one.
  if (record === null) {
    const reservation = await guard(() => ports.devices.reserve(operationId), { kind: 'unavailable' } as const);
    if (reservation.kind === 'unavailable') return retry;
    const next: OperationRecord = { v: 1, operationId, fingerprint, phase: 'reserved', deviceId: reservation.deviceId, binding: null };
    const saved = await guard(() => ports.operations.save(next, null), { kind: 'unavailable' } as const);
    if (saved.kind !== 'saved') return retry;
    record = next;
    revision = saved.revision;
  }
  const deviceId = record.deviceId;

  const owned = await guard(() => pairing.claim({
    code: pairingCode,
    descriptor,
    session,
    evidenceDigest: sessionEvidenceDigest(session, capabilities),
    deviceId,
    operationId,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }), { kind: 'unavailable' } as const);
  if (owned.kind === 'unavailable') return retry;
  if (owned.kind === 'pending') return { kind: 'pending', reason: owned.reason, retryable: true, operationId };
  if (owned.kind === 'refused') return blocked(owned.code);
  const { grant } = owned;
  if (grant.method !== PAIRING_METHOD || grant.redeem !== descriptor.redeem || grant.deviceId !== deviceId
    || !sameSession(grant.session, session) || !(grant.expiresAt > clock())) {
    return blocked('ownership_required');
  }
  return admit({ grant, session, operationId, record, revision }, ports);
}

/** Redeems a checked grant for the reserved device, then activates that same device. */
async function admit(
  state: Readonly<{ grant: OwnershipGrant; session: VerifiedSession; operationId: string; record: OperationRecord; revision: number | null }>,
  ports: BootstrapPorts,
): Promise<BootstrapResult> {
  const { grant, session, operationId } = state;
  let { record, revision } = state;
  const deviceId = record.deviceId;
  const retry: BootstrapResult = { kind: 'unavailable', retryable: true, operationId };
  const clock = ports.clock ?? Date.now;

  const admitted = await guard(() => ports.admission.redeem({ grant, operationId }), { kind: 'unavailable' } as const);
  if (admitted.kind === 'unavailable' || admitted.kind === 'outcome_unknown') return retry;
  if (admitted.kind === 'refused') return blocked(admitted.code);
  const decoded = decodeSessionBinding(admitted.binding);
  if (!decoded.ok) return blocked('admission_denied');
  const binding = decoded.value;
  if (binding.deviceId !== deviceId || !bindsSession(binding, session)) return blocked('admission_denied');
  if (record.binding && !sameSessionBinding(record.binding, binding)) return blocked('binding_conflict');
  const { capability } = admitted;
  // The capability must be for exactly this binding generation, and still live.
  if (capability.bindingId !== binding.bindingId || capability.generation !== binding.generation || !(capability.expiresAt > clock())) {
    return blocked('admission_denied');
  }

  const persist = async (phase: OperationRecord['phase']): Promise<boolean> => {
    const next: OperationRecord = { ...record!, phase, binding };
    const saved = await guard(() => ports.operations.save(next, revision), { kind: 'unavailable' } as const);
    if (saved.kind !== 'saved') return false;
    record = next;
    revision = saved.revision;
    return true;
  };

  if (record.phase === 'reserved' && !(await persist('admitted'))) return retry;

  const activation = await guard(
    () => ports.devices.activate({ deviceId, binding, capability, operationId }),
    { kind: 'unavailable' } as const,
  );
  if (activation.kind !== 'ready') {
    // Keep the device and binding so a retry or an owner revocation can repair it.
    await persist('repair_required');
    return activation.kind === 'failed' ? blocked('device_unavailable') : retry;
  }
  // The device is ready; a failed ledger write only costs a later retry an ownership step.
  await persist('connected');
  return { kind: 'connected', binding, reused: false };
}

function blocked(code: BlockedCode): BootstrapResult {
  return { kind: 'blocked', code };
}

function pickMethod(supported: readonly OwnershipMethod[], offered: readonly OwnershipMethod[]): OwnershipMethod | null {
  return supported.find(method => offered.includes(method)) ?? null;
}

function sameSession(a: VerifiedSession, b: VerifiedSession): boolean {
  return a.harness === b.harness && a.sessionId === b.sessionId && a.generation === b.generation;
}

function bindsSession(binding: SessionBinding, session: VerifiedSession): boolean {
  return binding.harness === session.harness && binding.sessionId === session.sessionId && binding.generation === session.generation;
}

function normalizeInput(input: BootstrapInput): NormalizedBootstrapInput | null {
  if (typeof input !== 'object' || input === null) return null;
  const candidate = input as Record<string, unknown>;
  const hasChannelUrl = Object.prototype.hasOwnProperty.call(candidate, 'channelUrl');
  const hasChatUrl = Object.prototype.hasOwnProperty.call(candidate, 'chatUrl');
  if (hasChannelUrl === hasChatUrl) return null;
  return {
    channelUrl: hasChannelUrl ? candidate.channelUrl as string : candidate.chatUrl as string,
    session: candidate.session as SessionClaim,
    operationId: candidate.operationId as string,
  };
}

function validInput(input: NormalizedBootstrapInput | null): input is NormalizedBootstrapInput {
  if (typeof input !== 'object' || input === null) return false;
  const { channelUrl, session, operationId } = input;
  if (typeof channelUrl !== 'string' || typeof operationId !== 'string' || !OPERATION_ID.test(operationId)) return false;
  if (typeof session !== 'object' || session === null) return false;
  return typeof session.harness === 'string' && HARNESS.test(session.harness)
    && boundedText(session.sessionId, MAX_FIELD_BYTES) && boundedText(session.workdir, MAX_WORKDIR_BYTES);
}

function validPairingInput(input: PairingBootstrapInput): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const keys = Object.keys(input);
  if (keys.length !== 3 || !['pairingCode', 'session', 'operationId'].every(key => keys.includes(key))) return false;
  try {
    readCanonicalCode(input.pairingCode, 'pairingCode');
  } catch {
    return false;
  }
  return validInput({ channelUrl: '', session: input.session, operationId: input.operationId });
}

function boundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= maxBytes && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Runs a port call; a throw becomes `fallback`, and its message is dropped. */
async function guard<T>(call: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await call();
  } catch {
    return fallback;
  }
}
