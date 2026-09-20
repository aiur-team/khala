// Agent-operated link bootstrap. The agent hands over the link the human pasted
// and its own session claim. The connector then discovers the service, verifies
// the native session, obtains owner authority through the proven ownership
// method, redeems admission for its own device, and reports one finite result.
// The link grants nothing by itself: owner, participant, device and binding
// identities exist only after verified ownership and admission.

import { createHash } from 'node:crypto';
import { type SessionBinding, decodeSessionBinding, sameSessionBinding } from '@khala/contracts/messaging/index';
import type { OwnershipMethod } from './descriptor';
import type {
  BootstrapPorts, OperationRecord, SessionClaim, VerifiedSession,
} from './ports';
import { admitsExistingSessionRoute } from '../route-admission';

export type BootstrapInput = Readonly<{
  chatUrl: string;
  session: SessionClaim;
  /** Caller-chosen and reused on every retry of the same setup. */
  operationId: string;
}>;

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
] as const;

export type BlockedCode = (typeof BLOCKED_CODES)[number];

export type BootstrapResult =
  | Readonly<{ kind: 'connected'; binding: SessionBinding; reused: boolean }>
  | Readonly<{ kind: 'blocked'; code: BlockedCode }>
  /** Nothing conclusive happened, or the outcome is unknown. Retry with the same `operationId`. */
  | Readonly<{ kind: 'unavailable'; retryable: true; operationId: string }>;

const OPERATION_ID = /^[A-Za-z0-9_-]{8,64}$/;
const HARNESS = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_FIELD_BYTES = 512;
const MAX_WORKDIR_BYTES = 4096;

/** Stable digest of everything a retry must repeat exactly. */
export function operationFingerprint(input: BootstrapInput): string {
  const { chatUrl, session } = input;
  return createHash('sha256')
    .update(JSON.stringify(['khala.bootstrap.v1', chatUrl, session.harness, session.sessionId, session.workdir]))
    .digest('base64url');
}

export async function bootstrapAgent(input: BootstrapInput, ports: BootstrapPorts): Promise<BootstrapResult> {
  if (!validInput(input)) return blocked('invalid_request');
  const { operationId } = input;
  const retry: BootstrapResult = { kind: 'unavailable', retryable: true, operationId };
  const clock = ports.clock ?? Date.now;
  const fingerprint = operationFingerprint(input);

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

  const discovered = await guard(() => ports.discovery.resolve(input.chatUrl), { kind: 'unavailable' } as const);
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
  if (session.harness !== input.session.harness || session.sessionId !== input.session.sessionId
    || !admitsExistingSessionRoute(capabilities, session.harness, ports.allowExperimentalAgentListener ?? false)) {
    return blocked('unsupported_harness');
  }
  // The binding is immutable: a new generation needs the owner's rebinding flow, not a reconnect.
  if (record?.binding && !bindsSession(record.binding, session)) return blocked('binding_conflict');

  const method = pickMethod(ports.ownership.methods, discovered.descriptor.methods);
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

function validInput(input: BootstrapInput): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const { chatUrl, session, operationId } = input;
  if (typeof chatUrl !== 'string' || typeof operationId !== 'string' || !OPERATION_ID.test(operationId)) return false;
  if (typeof session !== 'object' || session === null) return false;
  return typeof session.harness === 'string' && HARNESS.test(session.harness)
    && boundedText(session.sessionId, MAX_FIELD_BYTES) && boundedText(session.workdir, MAX_WORKDIR_BYTES);
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
