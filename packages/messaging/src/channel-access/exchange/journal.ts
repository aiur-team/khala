// Durable exchange state over the contract `ControlStore`. One record per
// (requester, origin, operation) holds the first bound key/device tuple, the
// provider operation recorded before any invocation, and the sealed envelope
// kept for byte-identical recovery. It never holds a plaintext grant.

import {
  CHANNEL_SEALED_BOX_ALGORITHM,
  type CallOptions,
  type ControlRecord,
  type ControlStore,
  type DeviceId,
  type JsonValue,
  type SealedGrantEnvelope,
  type StableAgentPrincipal,
  type WriteResult,
  decodeSealedGrantEnvelope,
} from '@khala/contracts/messaging/index';

export type ExchangePhase = 'bound' | 'admitting' | 'admitted' | 'sealed' | 'closed';

export type ExchangeRecord = Readonly<{
  v: 1;
  seq: number;
  operationId: string;
  requester: StableAgentPrincipal;
  origin: string;
  sessionGeneration: number;
  sessionFingerprint: string;
  deviceId: DeviceId;
  proofKeyThumbprint: string;
  encryptionPublicKey: string;
  encryptionKeyThumbprint: string;
  providerOperationId: string;
  createdAt: string;
  /** Hard expiry of this record: pre-seal work window, then the envelope recovery window. */
  expiresAt: string;
  phase: ExchangePhase;
  membership: 'joined' | 'already_joined' | null;
  envelope: SealedGrantEnvelope | null;
  closed: 'expired' | 'closed' | null;
}>;

export type StoredExchange = Readonly<{ key: string; record: ExchangeRecord; revision: string }>;

export type ExchangeLoad =
  | Readonly<{ kind: 'absent'; key: string }>
  | Readonly<{ kind: 'found'; stored: StoredExchange }>
  | Readonly<{ kind: 'unavailable' }>;

export type ExchangeSave =
  | Readonly<{ kind: 'saved'; stored: StoredExchange }>
  /** Another writer moved the record first; reload and continue from its state. */
  | Readonly<{ kind: 'conflict' }>
  | Readonly<{ kind: 'unavailable' }>;

export type KeyClaim = 'claimed' | 'key_reuse' | 'unavailable';

export type ExchangeJournal = Readonly<{
  key(identity: ExchangeIdentity): Promise<string | null>;
  load(identity: ExchangeIdentity, options?: CallOptions): Promise<ExchangeLoad>;
  create(key: string, record: ExchangeRecord, options?: CallOptions): Promise<ExchangeSave>;
  save(current: StoredExchange, next: ExchangeRecord, options?: CallOptions): Promise<ExchangeSave>;
  /** Pins one encryption public key to one exchange record, for as long as either may be used. */
  claimKey(input: Readonly<{ recordKey: string; publicKey: string; expiresAt: string }>, options?: CallOptions): Promise<KeyClaim>;
}>;

export type ExchangeIdentity = Readonly<{ requester: string; origin: string; operationId: string }>;

const RECORD_PREFIX = 'channel-access-exchange/';
const KEY_PREFIX = 'channel-access-exchange-key/';
const PHASES: readonly ExchangePhase[] = ['bound', 'admitting', 'admitted', 'sealed', 'closed'];
const RECORD_FIELDS = [
  'v', 'seq', 'operationId', 'requester', 'origin', 'sessionGeneration', 'sessionFingerprint', 'deviceId',
  'proofKeyThumbprint', 'encryptionPublicKey', 'encryptionKeyThumbprint', 'providerOperationId', 'createdAt',
  'expiresAt', 'phase', 'membership', 'envelope', 'closed',
] as const;

export async function sha256Hex(parts: readonly (string | number)[]): Promise<string | null> {
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(parts));
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
    return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

export function exchangeJournal(store: ControlStore): ExchangeJournal {
  async function key(identity: ExchangeIdentity): Promise<string | null> {
    const digest = await sha256Hex(['record', identity.requester, identity.origin, identity.operationId]);
    return digest === null ? null : `${RECORD_PREFIX}${digest}`;
  }

  async function load(identity: ExchangeIdentity, options?: CallOptions): Promise<ExchangeLoad> {
    const recordKey = await key(identity);
    if (recordKey === null) return { kind: 'unavailable' };
    const read = await safe(() => store.read(recordKey, options));
    if (read === null || read.kind === 'unavailable') return { kind: 'unavailable' };
    if (read.kind === 'absent') return { kind: 'absent', key: recordKey };
    const record = decodeRecord(read.record.value);
    // A record this module cannot read is never guessed at, and it is never overwritten.
    if (record === null || record.operationId !== identity.operationId || record.requester !== identity.requester
      || record.origin !== identity.origin) return { kind: 'unavailable' };
    return { kind: 'found', stored: { key: recordKey, record, revision: read.record.revision } };
  }

  async function write(
    recordKey: string,
    expectedRevision: string | null,
    record: ExchangeRecord,
    options?: CallOptions,
  ): Promise<ExchangeSave> {
    // The write ID names the record generation, position and phase, so a retry of one
    // transition can be resolved and a record recreated after expiry never reuses one.
    const writeId = `${recordKey}#${Date.parse(record.createdAt)}.${record.seq}.${record.phase}`;
    const result: WriteResult | null = await safe(() => store.compareAndSet({
      key: recordKey,
      expectedRevision,
      operationId: writeId,
      next: { value: encodeRecord(record), expiresAt: record.expiresAt },
    }, options));
    let applied: ControlRecord | null = null;
    if (result === null || result.kind === 'unavailable') return { kind: 'unavailable' };
    if (result.kind === 'conflict' || result.kind === 'operation_mismatch') return { kind: 'conflict' };
    if (result.kind === 'applied') applied = result.record;
    if (result.kind === 'outcome_unknown') {
      const resolved = await safe(() => store.resolve({ key: recordKey, operationId: writeId }, options));
      if (resolved?.kind === 'applied') applied = resolved.record;
      else return resolved?.kind === 'not_applied' ? { kind: 'conflict' } : { kind: 'unavailable' };
    }
    return { kind: 'saved', stored: { key: recordKey, record, revision: applied!.revision } };
  }

  async function claimKey(
    input: Readonly<{ recordKey: string; publicKey: string; expiresAt: string }>,
    options?: CallOptions,
  ): Promise<KeyClaim> {
    const digest = await sha256Hex(['encryption-key', input.publicKey]);
    if (digest === null) return 'unavailable';
    const indexKey = `${KEY_PREFIX}${digest}`;
    const value = { v: 1, recordKey: input.recordKey };
    const result = await safe(() => store.compareAndSet({
      key: indexKey,
      expectedRevision: null,
      operationId: `${indexKey}#${input.recordKey}`,
      next: { value, expiresAt: input.expiresAt },
    }, options));
    if (result === null || result.kind === 'unavailable') return 'unavailable';
    if (result.kind === 'applied') return 'claimed';
    if (result.kind === 'conflict' || result.kind === 'operation_mismatch') {
      const current = result.kind === 'conflict' ? result.current : await readRecord(indexKey);
      if (current === undefined) return 'unavailable';
      return (current?.value as { recordKey?: unknown } | undefined)?.recordKey === input.recordKey ? 'claimed' : 'key_reuse';
    }
    const resolved = await safe(() => store.resolve({ key: indexKey, operationId: `${indexKey}#${input.recordKey}` }, options));
    return resolved?.kind === 'applied' ? 'claimed' : 'unavailable';

    /** `undefined` means the read failed; `null` means no live claim. */
    async function readRecord(recordKey: string): Promise<ControlRecord | null | undefined> {
      const read = await safe(() => store.read(recordKey, options));
      if (read === null || read.kind === 'unavailable') return undefined;
      return read.kind === 'record' ? read.record : null;
    }
  }

  return Object.freeze({
    key,
    load,
    create: (recordKey: string, record: ExchangeRecord, options?: CallOptions) => write(recordKey, null, record, options),
    save: (current: StoredExchange, next: ExchangeRecord, options?: CallOptions) =>
      write(current.key, current.revision, { ...next, seq: current.record.seq + 1 }, options),
    claimKey,
  });
}

function encodeRecord(record: ExchangeRecord): JsonValue {
  return {
    v: record.v,
    seq: record.seq,
    operationId: record.operationId,
    requester: record.requester,
    origin: record.origin,
    sessionGeneration: record.sessionGeneration,
    sessionFingerprint: record.sessionFingerprint,
    deviceId: record.deviceId,
    proofKeyThumbprint: record.proofKeyThumbprint,
    encryptionPublicKey: record.encryptionPublicKey,
    encryptionKeyThumbprint: record.encryptionKeyThumbprint,
    providerOperationId: record.providerOperationId,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    phase: record.phase,
    membership: record.membership,
    envelope: record.envelope === null ? null : { ...record.envelope },
    closed: record.closed,
  };
}

export function decodeRecord(value: unknown): ExchangeRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const keys = Object.keys(r);
  if (keys.length !== RECORD_FIELDS.length || !RECORD_FIELDS.every(field => Object.hasOwn(r, field))) return null;
  const strings = ['operationId', 'requester', 'origin', 'sessionFingerprint', 'deviceId', 'proofKeyThumbprint',
    'encryptionPublicKey', 'encryptionKeyThumbprint', 'providerOperationId', 'createdAt', 'expiresAt'] as const;
  if (r.v !== 1 || !strings.every(field => typeof r[field] === 'string' && (r[field] as string).length > 0)) return null;
  if (!Number.isSafeInteger(r.seq) || (r.seq as number) < 1) return null;
  if (!Number.isSafeInteger(r.sessionGeneration)) return null;
  if (Number.isNaN(Date.parse(r.createdAt as string)) || Number.isNaN(Date.parse(r.expiresAt as string))) return null;
  if (!PHASES.includes(r.phase as ExchangePhase)) return null;
  if (r.membership !== null && r.membership !== 'joined' && r.membership !== 'already_joined') return null;
  if (r.closed !== null && r.closed !== 'expired' && r.closed !== 'closed') return null;
  let envelope: SealedGrantEnvelope | null = null;
  if (r.envelope !== null) {
    const decoded = decodeSealedGrantEnvelope(r.envelope);
    if (!decoded.ok || decoded.value.algorithm !== CHANNEL_SEALED_BOX_ALGORITHM) return null;
    envelope = decoded.value;
  }
  const phase = r.phase as ExchangePhase;
  // Phase invariants: only a sealed record has an envelope, only a closed one a reason,
  // and membership is known exactly from admission onward.
  if ((phase === 'sealed') !== (envelope !== null)) return null;
  if ((phase === 'closed') !== (r.closed !== null)) return null;
  if ((phase === 'admitted' || phase === 'sealed') && r.membership === null) return null;
  if ((phase === 'bound' || phase === 'admitting') && r.membership !== null) return null;
  if (envelope !== null && envelope.recipientKeyThumbprint !== r.encryptionKeyThumbprint) return null;
  return {
    v: 1,
    seq: r.seq as number,
    operationId: r.operationId as string,
    requester: r.requester as StableAgentPrincipal,
    origin: r.origin as string,
    sessionGeneration: r.sessionGeneration as number,
    sessionFingerprint: r.sessionFingerprint as string,
    deviceId: r.deviceId as DeviceId,
    proofKeyThumbprint: r.proofKeyThumbprint as string,
    encryptionPublicKey: r.encryptionPublicKey as string,
    encryptionKeyThumbprint: r.encryptionKeyThumbprint as string,
    providerOperationId: r.providerOperationId as string,
    createdAt: r.createdAt as string,
    expiresAt: r.expiresAt as string,
    phase,
    membership: r.membership as ExchangeRecord['membership'],
    envelope,
    closed: r.closed as ExchangeRecord['closed'],
  };
}

async function safe<T>(operation: () => Promise<T>): Promise<T | null> {
  try {
    return await operation();
  } catch {
    return null;
  }
}
