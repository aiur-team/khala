// Connector-side recovery of an owner-approved channel-access request (RD5B). The
// connector journals each operation locally, polls its status with bounded jittered
// backoff, and on approval reserves a device and a distinct X25519 recovery keypair.
// Both are durable before the exchange is called. It opens and validates the sealed
// result, redeems the grant, activates the device on the review baseline, and only
// then acknowledges readiness. `connected` exists only after that acknowledgement.
// Khala never launches or terminates the user's agent process here.

import {
  type AccessRequestOutcome,
  type ChannelAccessReadiness,
  type DeviceId,
  type GrantExchangeRejection,
  type GrantExchangeRequest,
  type SessionBinding,
  type StableAgentPrincipal,
  CHANNEL_ACCESS_ENVELOPE_RECOVERY_MS,
  CHANNEL_ACCESS_GRANT_LIFETIME_MS,
  decodeSealedGrantEnvelope,
  decodeSealedGrantPayload,
  decodeSessionBinding,
  deriveOkpKeyThumbprint,
  sameSessionBinding,
  validateSealedGrantPayload,
} from '@khala/contracts/messaging/index';
import sodium from 'libsodium-wrappers';
import { isAcceptableOrigin } from './discovery';
import { ADAPTER_CAPABILITIES, type AdmissionOutcome, type ConnectorDevicePort } from './ports';
import type { ProofSigner } from './proof';

export const ACTIVATION_PHASES = ['pending', 'keyed', 'admitted', 'activated', 'connected', 'repair_required', 'closed'] as const;
export type ActivationPhase = (typeof ACTIVATION_PHASES)[number];

/**
 * Known post-approval connector failures. Before admission, `recovery_key_lost` and
 * `grant_expired` cannot be repaired without a new grant, and the connector never asks for one.
 */
export const REPAIR_REASONS = [
  'recovery_key_lost',
  'grant_expired',
  'envelope_rejected',
  'exchange_conflict',
  'admission_refused',
  'activation_failed',
] as const;
export type RepairReason = (typeof REPAIR_REASONS)[number];

export const CLOSED_OUTCOMES = ['denied', 'expired', 'revoked', 'closed'] as const;
export type ClosedOutcome = (typeof CLOSED_OUTCOMES)[number];

/**
 * Non-secret, durable activation state for one requester operation. The X25519
 * private key is stored beside it by the journal, never inside it:
 * - `pending`: journaled; waiting for the owner.
 * - `keyed`: approved; the device and recovery key are fixed before any exchange.
 * - `admitted`: the grant was redeemed for `binding`; the device is not ready yet. From here
 *   on the operation resumes by ID, without the grant, until `recoverableUntil`.
 * - `activated`: the device is ready on the review baseline; readiness is unacknowledged.
 * - `connected`: the service acknowledged readiness.
 */
export type ActivationRecord = Readonly<{
  v: 1;
  operationId: string;
  requester: StableAgentPrincipal;
  origin: string;
  sessionGeneration: number;
  proofKeyThumbprint: string;
  phase: ActivationPhase;
  deviceId: string | null;
  recoveryPublicKey: string | null;
  recoveryKeyThumbprint: string | null;
  binding: SessionBinding | null;
  /** Epoch ms: the sealed envelope's recovery expiry, set with `binding`. */
  recoverableUntil: number | null;
  repair: RepairReason | null;
  closed: ClosedOutcome | null;
}>;

export type ActivationRead =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'record'; record: ActivationRecord; revision: number; recoveryKey: Uint8Array | null }>
  | Readonly<{ kind: 'unavailable' }>;

export type ActivationWrite =
  | Readonly<{ kind: 'saved'; revision: number }>
  | Readonly<{ kind: 'conflict' }>
  | Readonly<{ kind: 'unavailable' }>;

/** How a save treats the owner-only private key stored beside the record. */
export type RecoveryKeyWrite =
  | Readonly<{ kind: 'keep' }>
  | Readonly<{ kind: 'set'; privateKey: Uint8Array }>
  | Readonly<{ kind: 'clear' }>;

/** Durable, owner-only activation journal. Compare-and-set by revision; record and key commit together. */
export interface ChannelAccessActivationStore {
  load(operationId: string): Promise<ActivationRead>;
  /** `expectedRevision: null` creates only if absent. */
  save(record: ActivationRecord, expectedRevision: number | null, key: RecoveryKeyWrite): Promise<ActivationWrite>;
  /** Operation IDs that are neither connected nor closed, for resumption after restart. */
  listActive(): Promise<readonly string[] | 'unavailable'>;
}

/** Grant-free requester status for one operation. */
export interface ChannelAccessStatusPort {
  inspect(input: Readonly<{ operationId: string; origin: string }>): Promise<AccessRequestOutcome | 'unavailable'>;
}

export type ExchangeOutcome =
  /** The strict envelope is decoded again here; the client passes it through unopened. */
  | Readonly<{ kind: 'sealed'; envelope: unknown }>
  | Readonly<{ kind: 'rejected'; code: GrantExchangeRejection }>
  /** Nothing conclusive, including a lost response: the retry returns the same stored envelope. */
  | Readonly<{ kind: 'unavailable' }>;

export type ReadinessOutcome = 'acknowledged' | 'closed' | 'rejected' | 'unavailable';

/** Connector-only transport to the exchange and readiness routes. */
export interface ChannelAccessExchangeClient {
  exchange(request: GrantExchangeRequest): Promise<ExchangeOutcome>;
  acknowledge(readiness: ChannelAccessReadiness): Promise<ReadinessOutcome>;
}

/**
 * Redeems the opened one-time grant for the binding and adapter capability. Both calls
 * must be idempotent per operation for the same bound tuple, as `BootstrapAdmissionPort` is.
 */
export interface ChannelAccessRedeemPort {
  redeem(input: Readonly<{ grant: string; operationId: string; deviceId: string; origin: string }>): Promise<AdmissionOutcome>;
  /**
   * Returns the same binding with a fresh capability for an operation already redeemed. It needs
   * no grant, so a crash or repair after admission works after the 15-minute grant has expired.
   */
  resume(input: Readonly<{ operationId: string; deviceId: string; origin: string; bindingId: string }>): Promise<AdmissionOutcome>;
}

export type TrustInitialization =
  | Readonly<{ kind: 'initialized'; mode: string; paused: boolean }>
  | Readonly<{ kind: 'failed' }>
  | Readonly<{ kind: 'unavailable' }>;

/** Initializes the new binding's trust. Only the `review`, unpaused baseline is accepted. */
export interface ReviewTrustPort {
  initialize(binding: SessionBinding): Promise<TrustInitialization>;
}

export type ActivationPolling = Readonly<{
  /** First backoff ceiling in milliseconds. */
  baseMs: number;
  /** Backoff ceiling cap in milliseconds. */
  maxMs: number;
  /** Status or exchange attempts in one call before it returns a retryable result. */
  maxAttempts: number;
}>;

export const DEFAULT_ACTIVATION_POLLING: ActivationPolling = Object.freeze({ baseMs: 1_000, maxMs: 60_000, maxAttempts: 8 });

export type ChannelAccessActivationPorts = Readonly<{
  journal: ChannelAccessActivationStore;
  status: ChannelAccessStatusPort;
  exchange: ChannelAccessExchangeClient;
  redeem: ChannelAccessRedeemPort;
  devices: ConnectorDevicePort;
  trust: ReviewTrustPort;
  signer: Pick<ProofSigner, 'jkt' | 'publicKey'>;
  polling?: ActivationPolling;
  /** Trusted local time in epoch milliseconds. */
  clock?: () => number;
  /** Uniform in [0, 1); injected for deterministic jitter in tests. */
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}>;

export type ActivationResult =
  | Readonly<{ kind: 'connected'; binding: SessionBinding; reused: boolean }>
  /** Still waiting on the owner or the service. Call again with the same operation. */
  | Readonly<{ kind: 'pending'; outcome: 'pending_owner' }>
  | Readonly<{ kind: 'repair_required'; reason: RepairReason }>
  | Readonly<{ kind: 'closed'; outcome: ClosedOutcome }>
  | Readonly<{ kind: 'unavailable'; retryable: true }>
  | Readonly<{ kind: 'blocked'; code: 'invalid_request' | 'not_journaled' | 'operation_conflict' }>;

export type JournalRequestInput = Readonly<{
  operationId: string;
  requester: StableAgentPrincipal;
  origin: string;
  sessionGeneration: number;
}>;

const OPERATION_ID = /^[A-Za-z0-9_-]{8,64}$/;
const EXCHANGE_REQUEST_LIFETIME_MS = 60_000;
const MAX_STEPS = 12;
const UNREPAIRABLE: ReadonlySet<RepairReason> = new Set(['recovery_key_lost', 'grant_expired']);
const PROCEED: ReadonlySet<AccessRequestOutcome> = new Set(['approved', 'connecting', 'connected', 'repair_required']);
const CLOSING: ReadonlySet<AccessRequestOutcome> = new Set(['denied', 'expired', 'revoked']);

type Loaded = Extract<ActivationRead, { kind: 'record' }>;
type Step =
  | Readonly<{ kind: 'continue' }>
  /** Nothing conclusive yet; back off and try again within this call's budget. */
  | Readonly<{ kind: 'wait'; result: ActivationResult }>
  | Readonly<{ kind: 'done'; result: ActivationResult }>;

/**
 * Journals the operation before the access request is sent, so a restart resumes it.
 * Journaling the same operation again is idempotent; different input is a conflict.
 */
export async function journalChannelAccessRequest(
  input: JournalRequestInput,
  ports: Pick<ChannelAccessActivationPorts, 'journal' | 'signer'>,
): Promise<'journaled' | 'operation_conflict' | 'invalid_request' | 'unavailable'> {
  if (!validRequest(input)) return 'invalid_request';
  const record: ActivationRecord = {
    v: 1,
    operationId: input.operationId,
    requester: input.requester,
    origin: input.origin,
    sessionGeneration: input.sessionGeneration,
    proofKeyThumbprint: ports.signer.jkt,
    phase: 'pending',
    deviceId: null,
    recoveryPublicKey: null,
    recoveryKeyThumbprint: null,
    binding: null,
    recoverableUntil: null,
    repair: null,
    closed: null,
  };
  const loaded = await guard(() => ports.journal.load(input.operationId), { kind: 'unavailable' } as const);
  if (loaded.kind === 'unavailable') return 'unavailable';
  if (loaded.kind === 'record') return sameRequest(loaded.record, record) ? 'journaled' : 'operation_conflict';
  const saved = await guard(() => ports.journal.save(record, null, { kind: 'keep' }), { kind: 'unavailable' } as const);
  if (saved.kind === 'saved') return 'journaled';
  if (saved.kind === 'unavailable') return 'unavailable';
  const raced = await guard(() => ports.journal.load(input.operationId), { kind: 'unavailable' } as const);
  if (raced.kind !== 'record') return 'unavailable';
  return sameRequest(raced.record, record) ? 'journaled' : 'operation_conflict';
}

/**
 * Advances one journaled operation as far as it can go, polling with bounded jittered
 * backoff while the owner or service is not ready. `repair: true` resumes a
 * repairable `repair_required` operation with the same device and recovery key.
 */
export async function activateChannelAccess(
  operationId: string,
  ports: ChannelAccessActivationPorts,
  options: Readonly<{ repair?: boolean; signal?: AbortSignal | undefined }> = {},
): Promise<ActivationResult> {
  if (typeof operationId !== 'string' || !OPERATION_ID.test(operationId)) return blocked('invalid_request');
  const polling = ports.polling ?? DEFAULT_ACTIVATION_POLLING;
  const sleep = ports.sleep ?? defaultSleep;
  const random = ports.random ?? Math.random;
  let repair = options.repair === true;
  let last: ActivationResult = unavailable();
  for (let attempt = 0; attempt < polling.maxAttempts; attempt += 1) {
    if (options.signal?.aborted === true) return last;
    const step = await attemptOnce(operationId, ports, repair);
    // Repair applies to the transition out of `repair_required` only, never to a later failure.
    repair = false;
    if (step.kind === 'done') return step.result;
    last = step.kind === 'wait' ? step.result : unavailable();
    if (attempt + 1 < polling.maxAttempts) {
      await guard(() => sleep(backoff(attempt, polling, random), options.signal), undefined);
    }
  }
  return last;
}

/** Resumes every journaled operation that is neither connected nor closed, after a restart. */
export async function resumeChannelAccessActivations(
  ports: ChannelAccessActivationPorts,
  options: Readonly<{ signal?: AbortSignal | undefined }> = {},
): Promise<readonly Readonly<{ operationId: string; result: ActivationResult }>[] | 'unavailable'> {
  const active = await guard(() => ports.journal.listActive(), 'unavailable' as const);
  if (active === 'unavailable') return active;
  const results: { operationId: string; result: ActivationResult }[] = [];
  for (const operationId of active) {
    results.push({ operationId, result: await activateChannelAccess(operationId, ports, { signal: options.signal }) });
  }
  return results;
}

/** Ceiling doubles from `baseMs` up to `maxMs`; the delay is jittered in its upper half. */
export function backoff(attempt: number, polling: ActivationPolling, random: () => number): number {
  const ceiling = Math.min(polling.maxMs, polling.baseMs * 2 ** Math.min(attempt, 30));
  const unit = Math.min(Math.max(random(), 0), 1);
  return Math.floor(ceiling / 2 + (ceiling / 2) * unit);
}

async function attemptOnce(operationId: string, ports: ChannelAccessActivationPorts, repair: boolean): Promise<Step> {
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const loaded = await guard(() => ports.journal.load(operationId), { kind: 'unavailable' } as const);
    if (loaded.kind === 'unavailable') return wait(unavailable());
    if (loaded.kind === 'absent') return done(blocked('not_journaled'));
    // A failure after resuming ends the attempt as `done`, so repair never loops.
    const next = await advance(loaded, ports, repair);
    if (next.kind !== 'continue') return next;
  }
  return wait(unavailable());
}

async function advance(loaded: Loaded, ports: ChannelAccessActivationPorts, repair: boolean): Promise<Step> {
  const record = loaded.record;
  switch (record.phase) {
    case 'closed':
      return done({ kind: 'closed', outcome: record.closed! });
    case 'connected':
      return reconnected(loaded, ports);
    case 'repair_required':
      if (!repair || UNREPAIRABLE.has(record.repair!)) return done({ kind: 'repair_required', reason: record.repair! });
      // Resume the same operation, device and recovery key; no new owner prompt. An admitted
      // operation resumes by ID and never needs the grant again.
      return saved(await save(ports, loaded, {
        ...record, phase: record.binding === null ? 'keyed' : 'admitted', repair: null,
      }, { kind: 'keep' }));
    case 'pending':
      return approve(loaded, ports);
    case 'activated':
      return acknowledge(loaded, ports);
    case 'keyed':
      return recover(loaded, ports);
    case 'admitted':
      return resume(loaded, ports);
  }
}

async function reconnected(loaded: Loaded, ports: ChannelAccessActivationPorts): Promise<Step> {
  const { record } = loaded;
  const status = await guard(() => ports.devices.status(record.deviceId!), 'unavailable' as const);
  if (status === 'unavailable') return wait(unavailable());
  if (status === 'ready') return done({ kind: 'connected', binding: record.binding!, reused: true });
  return repairRequired(ports, loaded, 'activation_failed');
}

async function approve(loaded: Loaded, ports: ChannelAccessActivationPorts): Promise<Step> {
  const { record } = loaded;
  const outcome = await guard(
    () => ports.status.inspect({ operationId: record.operationId, origin: record.origin }),
    'unavailable' as const,
  );
  if (outcome === 'pending_owner') return wait({ kind: 'pending', outcome: 'pending_owner' });
  if (CLOSING.has(outcome as AccessRequestOutcome)) {
    return close(ports, loaded, outcome as ClosedOutcome);
  }
  // Unknown, stale, or ambiguous status collapses to `unavailable` and reconciles by operation ID.
  if (!PROCEED.has(outcome as AccessRequestOutcome)) return wait(unavailable());

  const reservation = await guard(() => ports.devices.reserve(record.operationId), { kind: 'unavailable' } as const);
  if (reservation.kind === 'unavailable') return wait(unavailable());
  const key = await generateRecoveryKey();
  if (key === null) return wait(unavailable());
  // The device, both key thumbprints and the private key are durable before any exchange.
  return saved(await save(ports, loaded, {
    ...record,
    phase: 'keyed',
    deviceId: reservation.deviceId,
    recoveryPublicKey: key.publicKey,
    recoveryKeyThumbprint: key.thumbprint,
  }, { kind: 'set', privateKey: key.privateKey }));
}

async function recover(loaded: Loaded, ports: ChannelAccessActivationPorts): Promise<Step> {
  const { record } = loaded;
  const clock = ports.clock ?? Date.now;
  if (record.proofKeyThumbprint !== ports.signer.jkt) return repairRequired(ports, loaded, 'exchange_conflict');
  const privateKey = await heldPrivateKey(loaded);
  if (privateKey === null) {
    // Before a sealed result exists, a new key supersedes the lost one on the server.
    // After consumption the server refuses it (`encryption_key_mismatch`) and nothing is reminted.
    const key = await generateRecoveryKey();
    if (key === null) return wait(unavailable());
    return saved(await save(ports, loaded, {
      ...record, recoveryPublicKey: key.publicKey, recoveryKeyThumbprint: key.thumbprint,
    }, { kind: 'set', privateKey: key.privateKey }));
  }

  const exchanged = await guard(() => ports.exchange.exchange({
    v: 1,
    operationId: record.operationId,
    requester: record.requester,
    origin: record.origin,
    proofKey: { algorithm: 'Ed25519', publicKey: ports.signer.publicKey, thumbprint: ports.signer.jkt },
    encryptionKey: { algorithm: 'X25519', publicKey: record.recoveryPublicKey!, thumbprint: record.recoveryKeyThumbprint! },
    deviceId: record.deviceId! as DeviceId,
    sessionGeneration: record.sessionGeneration,
    expiresAt: new Date(clock() + EXCHANGE_REQUEST_LIFETIME_MS).toISOString(),
  }), { kind: 'unavailable' } as const);
  if (exchanged.kind === 'unavailable') return wait(unavailable());
  if (exchanged.kind === 'rejected') {
    if (exchanged.code === 'closed') return close(ports, loaded, 'closed');
    if (exchanged.code === 'expired') return close(ports, loaded, 'expired');
    if (exchanged.code === 'crypto_unavailable') return wait(unavailable());
    // The envelope was sealed to a key this connector no longer holds.
    if (exchanged.code === 'encryption_key_mismatch') return repairRequired(ports, loaded, 'recovery_key_lost');
    return repairRequired(ports, loaded, 'exchange_conflict');
  }

  const now = clock();
  const opened = await openEnvelope(exchanged.envelope, record, privateKey, now);
  if (opened.kind === 'rejected') return repairRequired(ports, loaded, opened.reason);

  const redeemed = await guard(() => ports.redeem.redeem({
    grant: opened.grant, operationId: record.operationId, deviceId: record.deviceId!, origin: record.origin,
  }), { kind: 'unavailable' } as const);
  // The service seals the grant with a fixed lifetime, so its expiry dates the sealing that
  // starts the recovery window. It never counts from later than now.
  const sealedAt = Math.min(opened.expiresAtMs - CHANNEL_ACCESS_GRANT_LIFETIME_MS, now);
  return activate(loaded, ports, redeemed, sealedAt + CHANNEL_ACCESS_ENVELOPE_RECOVERY_MS);
}

/** Resumes an admitted operation by ID with the same device and binding; no grant is needed. */
async function resume(loaded: Loaded, ports: ChannelAccessActivationPorts): Promise<Step> {
  const { record } = loaded;
  const clock = ports.clock ?? Date.now;
  // Past the recovery window the service has dropped the envelope, so recovery fails closed.
  if (!(clock() < record.recoverableUntil!)) return close(ports, loaded, 'expired');
  if (record.proofKeyThumbprint !== ports.signer.jkt) return repairRequired(ports, loaded, 'exchange_conflict');
  const redeemed = await guard(() => ports.redeem.resume({
    operationId: record.operationId, deviceId: record.deviceId!, origin: record.origin, bindingId: record.binding!.bindingId,
  }), { kind: 'unavailable' } as const);
  return activate(loaded, ports, redeemed, record.recoverableUntil!);
}

async function activate(
  loaded: Loaded,
  ports: ChannelAccessActivationPorts,
  redeemed: AdmissionOutcome,
  recoverableUntil: number,
): Promise<Step> {
  const { record } = loaded;
  const clock = ports.clock ?? Date.now;
  if (redeemed.kind === 'unavailable' || redeemed.kind === 'outcome_unknown') return wait(unavailable());
  if (redeemed.kind === 'refused') {
    return redeemed.code === 'binding_revoked' ? close(ports, loaded, 'revoked') : repairRequired(ports, loaded, 'admission_refused');
  }
  const decoded = decodeSessionBinding(redeemed.binding);
  if (!decoded.ok) return repairRequired(ports, loaded, 'admission_refused');
  const binding = decoded.value;
  if (binding.deviceId !== record.deviceId || binding.generation !== record.sessionGeneration) {
    return repairRequired(ports, loaded, 'admission_refused');
  }
  if (record.binding !== null && !sameSessionBinding(record.binding, binding)) return repairRequired(ports, loaded, 'exchange_conflict');
  const { capability } = redeemed;
  if (capability.bindingId !== binding.bindingId || capability.generation !== binding.generation
    || !(capability.expiresAt > clock()) || !exactAdapterScope(capability.scope)) {
    return repairRequired(ports, loaded, 'admission_refused');
  }

  let current = loaded;
  if (record.phase !== 'admitted' || record.binding === null) {
    const write = await save(ports, loaded, { ...record, phase: 'admitted', binding, recoverableUntil }, { kind: 'keep' });
    if (write.kind !== 'saved') return saved(write);
    current = write.loaded;
  }

  const activation = await guard(
    () => ports.devices.activate({ deviceId: record.deviceId!, binding, capability, operationId: record.operationId }),
    { kind: 'unavailable' } as const,
  );
  if (activation.kind === 'unavailable') return wait(unavailable());
  if (activation.kind === 'failed') return repairRequired(ports, current, 'activation_failed');

  const trust = await guard(() => ports.trust.initialize(binding), { kind: 'unavailable' } as const);
  if (trust.kind === 'unavailable') return wait(unavailable());
  // A new binding starts in effective review, unpaused; anything else is not a readiness baseline.
  if (trust.kind === 'failed' || trust.mode !== 'review' || trust.paused) return repairRequired(ports, current, 'activation_failed');

  return saved(await save(ports, current, { ...current.record, phase: 'activated' }, { kind: 'keep' }));
}

async function acknowledge(loaded: Loaded, ports: ChannelAccessActivationPorts): Promise<Step> {
  const { record } = loaded;
  const status = await guard(() => ports.devices.status(record.deviceId!), 'unavailable' as const);
  if (status === 'unavailable') return wait(unavailable());
  if (status !== 'ready') return repairRequired(ports, loaded, 'activation_failed');
  const acknowledged = await guard(() => ports.exchange.acknowledge({
    v: 1,
    operationId: record.operationId,
    requester: record.requester,
    origin: record.origin,
    sessionGeneration: record.sessionGeneration,
    deviceId: record.deviceId! as DeviceId,
    proofKeyThumbprint: record.proofKeyThumbprint,
    recipientKeyThumbprint: record.recoveryKeyThumbprint!,
  }), 'unavailable' as const);
  if (acknowledged === 'unavailable') return wait(unavailable());
  if (acknowledged === 'closed') return close(ports, loaded, 'closed');
  if (acknowledged === 'rejected') return repairRequired(ports, loaded, 'exchange_conflict');
  // Only an acknowledged readiness reaches `connected`. The recovery key has done its job.
  const write = await save(ports, loaded, { ...record, phase: 'connected' }, { kind: 'clear' });
  if (write.kind !== 'saved') return saved(write);
  return done({ kind: 'connected', binding: record.binding!, reused: false });
}

type Opened =
  | Readonly<{ kind: 'opened'; grant: string; expiresAtMs: number }>
  | Readonly<{ kind: 'rejected'; reason: 'grant_expired' | 'envelope_rejected' }>;

/** Opens the sealed result and checks version, algorithm, both thumbprints and the sealed context. */
async function openEnvelope(input: unknown, record: ActivationRecord, privateKey: Uint8Array, nowMs: number): Promise<Opened> {
  const envelope = decodeSealedGrantEnvelope(input);
  if (!envelope.ok) return { kind: 'rejected', reason: 'envelope_rejected' };
  // The service refuses a key it did not seal to (`encryption_key_mismatch`), so an envelope naming
  // another key is corrupt, not proof of key loss; a repair re-fetches the stored bytes.
  if (envelope.value.recipientKeyThumbprint !== record.recoveryKeyThumbprint) return { kind: 'rejected', reason: 'envelope_rejected' };
  let plaintext: string;
  try {
    await sodium.ready;
    const ciphertext = sodium.from_base64(envelope.value.ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING);
    const publicKey = sodium.from_base64(record.recoveryPublicKey!, sodium.base64_variants.URLSAFE_NO_PADDING);
    plaintext = sodium.to_string(sodium.crypto_box_seal_open(ciphertext, publicKey, privateKey));
  } catch {
    return { kind: 'rejected', reason: 'envelope_rejected' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return { kind: 'rejected', reason: 'envelope_rejected' };
  }
  const payload = decodeSealedGrantPayload(parsed);
  if (!payload.ok) return { kind: 'rejected', reason: 'envelope_rejected' };
  const validity = validateSealedGrantPayload(payload.value, {
    operationId: record.operationId,
    requester: record.requester,
    origin: record.origin,
    sessionGeneration: record.sessionGeneration,
    deviceId: record.deviceId! as DeviceId,
    proofKeyThumbprint: record.proofKeyThumbprint,
    recipientKeyThumbprint: record.recoveryKeyThumbprint!,
    nowMs,
  });
  if (validity === 'expired') return { kind: 'rejected', reason: 'grant_expired' };
  if (validity !== 'valid') return { kind: 'rejected', reason: 'envelope_rejected' };
  return { kind: 'opened', grant: payload.value.grant, expiresAtMs: Date.parse(payload.value.expiresAt) };
}

type RecoveryKey = Readonly<{ publicKey: string; thumbprint: string; privateKey: Uint8Array }>;

async function generateRecoveryKey(): Promise<RecoveryKey | null> {
  try {
    await sodium.ready;
    const pair = sodium.crypto_box_keypair();
    const publicKey = sodium.to_base64(pair.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
    const derived = await deriveOkpKeyThumbprint({ algorithm: 'X25519', publicKey, thumbprint: '' });
    return derived.ok ? { publicKey, thumbprint: derived.thumbprint, privateKey: pair.privateKey } : null;
  } catch {
    return null;
  }
}

/** The stored private key, only when it is the one whose public half the record names. */
async function heldPrivateKey(loaded: Loaded): Promise<Uint8Array | null> {
  const { recoveryKey, record } = loaded;
  if (recoveryKey === null || record.recoveryPublicKey === null) return null;
  try {
    await sodium.ready;
    if (recoveryKey.length !== sodium.crypto_box_SECRETKEYBYTES) return null;
    const derived = sodium.to_base64(sodium.crypto_scalarmult_base(recoveryKey), sodium.base64_variants.URLSAFE_NO_PADDING);
    return derived === record.recoveryPublicKey ? recoveryKey : null;
  } catch {
    return null;
  }
}

type SaveResult =
  | Readonly<{ kind: 'saved'; loaded: Loaded }>
  | Readonly<{ kind: 'conflict' }>
  | Readonly<{ kind: 'unavailable' }>;

async function save(
  ports: ChannelAccessActivationPorts,
  loaded: Loaded,
  next: ActivationRecord,
  key: RecoveryKeyWrite,
): Promise<SaveResult> {
  const write = await guard(() => ports.journal.save(next, loaded.revision, key), { kind: 'unavailable' } as const);
  if (write.kind !== 'saved') return write;
  const recoveryKey = key.kind === 'set' ? key.privateKey : key.kind === 'clear' ? null : loaded.recoveryKey;
  return { kind: 'saved', loaded: { kind: 'record', record: next, revision: write.revision, recoveryKey } };
}

/** A saved transition continues from a fresh load; a lost race reloads; a failed write waits. */
function saved(write: SaveResult): Step {
  return write.kind === 'unavailable' ? wait(unavailable()) : { kind: 'continue' };
}

async function repairRequired(ports: ChannelAccessActivationPorts, loaded: Loaded, reason: RepairReason): Promise<Step> {
  // Keep the device, binding and recovery key so a repair can resume the same operation.
  const write = await save(ports, loaded, { ...loaded.record, phase: 'repair_required', repair: reason }, { kind: 'keep' });
  if (write.kind === 'conflict') return { kind: 'continue' };
  return done({ kind: 'repair_required', reason });
}

async function close(ports: ChannelAccessActivationPorts, loaded: Loaded, outcome: ClosedOutcome): Promise<Step> {
  const write = await save(ports, loaded, { ...loaded.record, phase: 'closed', closed: outcome, repair: null }, { kind: 'clear' });
  if (write.kind === 'conflict') return { kind: 'continue' };
  return done({ kind: 'closed', outcome });
}

function sameRequest(a: ActivationRecord, b: ActivationRecord): boolean {
  return a.operationId === b.operationId && a.requester === b.requester && a.origin === b.origin
    && a.sessionGeneration === b.sessionGeneration && a.proofKeyThumbprint === b.proofKeyThumbprint;
}

function validRequest(input: JournalRequestInput): boolean {
  if (typeof input !== 'object' || input === null) return false;
  return typeof input.operationId === 'string' && OPERATION_ID.test(input.operationId)
    && typeof input.requester === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(input.requester)
    && typeof input.origin === 'string' && isAcceptableOrigin(input.origin)
    && Number.isSafeInteger(input.sessionGeneration) && input.sessionGeneration >= 0;
}

function exactAdapterScope(scope: readonly string[]): boolean {
  return scope.length === ADAPTER_CAPABILITIES.length && ADAPTER_CAPABILITIES.every(action => scope.includes(action));
}

/** Strict decoder for a stored activation record; `null` for anything this module did not write. */
export function decodeActivationRecord(value: unknown): ActivationRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const fields = [
    'v', 'operationId', 'requester', 'origin', 'sessionGeneration', 'proofKeyThumbprint', 'phase', 'deviceId',
    'recoveryPublicKey', 'recoveryKeyThumbprint', 'binding', 'recoverableUntil', 'repair', 'closed',
  ];
  if (Object.keys(r).length !== fields.length || !fields.every(field => Object.hasOwn(r, field))) return null;
  if (r.v !== 1 || !ACTIVATION_PHASES.includes(r.phase as ActivationPhase)) return null;
  const phase = r.phase as ActivationPhase;
  const request = {
    operationId: r.operationId, requester: r.requester, origin: r.origin, sessionGeneration: r.sessionGeneration,
  } as JournalRequestInput;
  if (!validRequest(request) || !nonEmpty(r.proofKeyThumbprint)) return null;
  for (const field of ['deviceId', 'recoveryPublicKey', 'recoveryKeyThumbprint'] as const) {
    if (r[field] !== null && !nonEmpty(r[field])) return null;
  }
  if (r.repair !== null && !REPAIR_REASONS.includes(r.repair as RepairReason)) return null;
  if (r.closed !== null && !CLOSED_OUTCOMES.includes(r.closed as ClosedOutcome)) return null;
  let binding: SessionBinding | null = null;
  if (r.binding !== null) {
    const decoded = decodeSessionBinding(r.binding);
    if (!decoded.ok || decoded.value.deviceId !== r.deviceId) return null;
    binding = decoded.value;
  }
  if (r.recoverableUntil !== null && !(Number.isSafeInteger(r.recoverableUntil) && (r.recoverableUntil as number) > 0)) return null;
  // Phase invariants: a key and device from `keyed` on, a binding and its recovery window from
  // `admitted` through `connected`, and a reason exactly on the repair and closed phases.
  const keyed = r.deviceId !== null && r.recoveryPublicKey !== null && r.recoveryKeyThumbprint !== null;
  if (phase === 'pending' && (r.deviceId !== null || r.recoveryPublicKey !== null || binding !== null)) return null;
  if ((phase === 'keyed' || phase === 'admitted' || phase === 'activated' || phase === 'connected') && !keyed) return null;
  if ((phase === 'admitted' || phase === 'activated' || phase === 'connected') && binding === null) return null;
  if ((binding === null) !== (r.recoverableUntil === null)) return null;
  if ((phase === 'repair_required') !== (r.repair !== null)) return null;
  if (phase === 'repair_required' && !keyed) return null;
  if ((phase === 'closed') !== (r.closed !== null)) return null;
  return {
    v: 1,
    operationId: request.operationId,
    requester: request.requester,
    origin: request.origin,
    sessionGeneration: request.sessionGeneration,
    proofKeyThumbprint: r.proofKeyThumbprint as string,
    phase,
    deviceId: r.deviceId as string | null,
    recoveryPublicKey: r.recoveryPublicKey as string | null,
    recoveryKeyThumbprint: r.recoveryKeyThumbprint as string | null,
    binding,
    recoverableUntil: r.recoverableUntil as number | null,
    repair: r.repair as RepairReason | null,
    closed: r.closed as ClosedOutcome | null,
  };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function done(result: ActivationResult): Step {
  return { kind: 'done', result };
}

function wait(result: ActivationResult): Step {
  return { kind: 'wait', result };
}

function blocked(code: Extract<ActivationResult, { kind: 'blocked' }>['code']): ActivationResult {
  return { kind: 'blocked', code };
}

function unavailable(): ActivationResult {
  return { kind: 'unavailable', retryable: true };
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
  });
}

/** Runs a port call; a throw becomes `fallback`, and its message is dropped. */
async function guard<T>(call: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await call();
  } catch {
    return fallback;
  }
}
