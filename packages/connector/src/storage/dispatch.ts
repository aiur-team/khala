// SQLite-backed dispatch ports. This adapter shares the connector's one open
// storage lease and maps the KHA-121 synchronous transaction contract onto the
// same IMMEDIATE transactions used by the rest of the application ledger.

import type {
  ApprovalCommand, BindingId, CausalRootId, CommandId, ReleaseId, SessionBinding,
} from '@khala/contracts/delivery/index';
import {
  decodeApprovalCommand, decodeDeliveryReceipt, decodeReleasedJob, decodeSessionBinding, sameSessionBinding,
} from '@khala/contracts/delivery/index';
import { usablePolicy } from '../dispatch/budget';
import { sameRelease } from '../dispatch/claim';
import {
  ACTIVE_STATES, MAX_RECEIPTS, type BindingState, type BlockCode, type DispatchLedger, type DispatchPolicy,
  type DispatchRecord, type DispatchState, type DispatchTx, type QuarantineCode,
} from '../dispatch/types';
import { StorageError } from './errors';
import {
  bumpRevision, requireCount, requireIdentifier, requireTimestamp, runTransaction,
} from './ledger';
import { type ConnectorStorage, storageInternals } from './open';
import { sha256Digest } from './payloads';

const STATES: readonly DispatchState[] = [
  'queued', 'quarantined', 'rejected', 'dispatching', 'accepted', 'outcome_unknown', 'completed', 'failed', 'cancelled',
  'abandoned',
];
const REASONS: readonly (BlockCode | QuarantineCode)[] = [
  'paused', 'budget_exhausted', 'stale_binding', 'stale_policy', 'revoked', 'busy', 'expired', 'claimed_elsewhere',
  'unconfigured', 'at_capacity', 'harness_unsupported', 'approval_missing', 'approval_mismatch', 'release_invalid',
  'payload_missing', 'payload_invalid', 'payload_digest_mismatch',
];
const RECORD_KEYS = [
  'abandonedBy', 'attemptId', 'claimedAt', 'job', 'reason', 'receipts', 'releaseId', 'seq', 'state', 'workerId',
];

function context(storage: ConnectorStorage) {
  const internals = storageInternals.get(storage);
  if (!internals) throw new StorageError('closed');
  internals.assertUsable();
  return internals.ctx;
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    throw new StorageError('corrupt');
  }
}

function nullableIdentifier(value: unknown, fail: () => never): string | null {
  if (value === null) return null;
  try {
    return requireIdentifier(value);
  } catch {
    return fail();
  }
}

function decodeRecord(input: unknown, limits: ReturnType<typeof context>['limits'], stored: boolean): DispatchRecord {
  const fail = (): never => { throw new StorageError(stored ? 'corrupt' : 'invalid_input'); };
  if (typeof input !== 'object' || input === null) return fail();
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (keys.length !== RECORD_KEYS.length || keys.some((key, index) => key !== RECORD_KEYS[index])) return fail();
  const decodedJob = decodeReleasedJob(value.job, limits);
  if (!decodedJob.ok) return fail();
  const job = decodedJob.value;
  let releaseId: string;
  let seq: number;
  try {
    releaseId = requireIdentifier(value.releaseId);
    seq = requireCount(value.seq);
  } catch {
    return fail();
  }
  if (releaseId !== job.releaseId || seq < 1 || !STATES.includes(value.state as DispatchState)) return fail();
  const state = value.state as DispatchState;
  const reason = value.reason === null ? null : value.reason as BlockCode | QuarantineCode;
  if (reason !== null && !REASONS.includes(reason)) return fail();
  const attemptId = nullableIdentifier(value.attemptId, fail);
  const workerId = nullableIdentifier(value.workerId, fail);
  let claimedAt: string | null = null;
  if (value.claimedAt !== null) {
    try { claimedAt = requireTimestamp(value.claimedAt); } catch { return fail(); }
  }
  if ((attemptId === null) !== (workerId === null) || (attemptId === null) !== (claimedAt === null)) return fail();
  if (!Array.isArray(value.receipts) || value.receipts.length > MAX_RECEIPTS) return fail();
  const receipts = value.receipts.map(receipt => {
    const decoded = decodeDeliveryReceipt(receipt);
    if (!decoded.ok || decoded.value.releaseId !== job.releaseId
      || decoded.value.bindingId !== job.binding.bindingId || decoded.value.generation !== job.binding.generation) return fail();
    return decoded.value;
  });
  if (new Set(receipts.map(receipt => receipt.receiptId)).size !== receipts.length) return fail();
  const abandonedBy = nullableIdentifier(value.abandonedBy, fail) as DispatchRecord['abandonedBy'];
  if ((state === 'abandoned') !== (abandonedBy !== null)) return fail();
  return {
    releaseId: releaseId as ReleaseId,
    seq,
    job,
    state,
    reason,
    attemptId,
    workerId,
    claimedAt,
    receipts,
    abandonedBy,
  };
}

function storedRecord(json: string, limits: ReturnType<typeof context>['limits']): DispatchRecord {
  return decodeRecord(parseJson(json), limits, true);
}

function storedBinding(db: ReturnType<typeof context>['db'], bindingId: BindingId): SessionBinding | null {
  const id = requireIdentifier(bindingId);
  const row = db.prepare('SELECT binding FROM bindings WHERE binding_id = ?').get(id) as { binding: string } | undefined;
  if (!row) return null;
  const decoded = decodeSessionBinding(parseJson(row.binding));
  if (!decoded.ok || decoded.value.bindingId !== id) throw new StorageError('corrupt');
  return decoded.value;
}

function bindingRevoked(db: ReturnType<typeof context>['db'], binding: SessionBinding): boolean {
  return db.prepare(`SELECT 1 FROM revocations WHERE (target_kind = 'binding' AND target_id = ?)
    OR (target_kind = 'device' AND target_id = ?) LIMIT 1`).get(binding.bindingId, binding.deviceId) !== undefined;
}

function decodePolicy(json: string, bindingId: string, generation: number, version: number): DispatchPolicy {
  const policy = parseJson(json) as DispatchPolicy;
  if (!usablePolicy(policy) || policy.version !== version) throw new StorageError('corrupt');
  requireIdentifier(bindingId);
  requireCount(generation);
  return policy;
}

function canonicalPolicy(policy: DispatchPolicy): DispatchPolicy {
  return {
    version: policy.version,
    armedAt: policy.armedAt,
    paused: policy.paused,
    maxJobsPerCausalRoot: policy.maxJobsPerCausalRoot,
    maxConcurrentJobs: policy.maxConcurrentJobs,
    expiresAt: policy.expiresAt,
    busy: policy.busy,
  };
}

function makeTx(storage: ConnectorStorage, live: () => boolean): { tx: DispatchTx; failed: () => boolean } {
  const ctx = context(storage);
  const { db, limits } = ctx;
  let failed = false;
  const guard = () => {
    if (!live()) throw new StorageError('transaction_aborted');
    if (!db.isTransaction) throw new StorageError('transaction_aborted');
  };
  const guarded = <A extends unknown[], R>(method: (...args: A) => R) => (...args: A): R => {
    try {
      guard();
      return method(...args);
    } catch (error) {
      failed = true;
      throw error;
    }
  };
  const record = (releaseId: ReleaseId): DispatchRecord | null => {
    const id = requireIdentifier(releaseId);
    const row = db.prepare('SELECT record FROM dispatch_records WHERE release_id = ?').get(id) as
      | { record: string }
      | undefined;
    return row ? storedRecord(row.record, limits) : null;
  };
  const records = (where: string): DispatchRecord[] => (db.prepare(
    `SELECT record FROM dispatch_records ${where} ORDER BY seq`,
  ).all() as { record: string }[]).map(row => storedRecord(row.record, limits));

  const tx: DispatchTx = {
    policy: guarded((bindingId: BindingId): DispatchPolicy | null => {
      const id = requireIdentifier(bindingId);
      const row = db.prepare(`SELECT generation, version, policy FROM dispatch_policies
        WHERE binding_id = ?`).get(id) as { generation: number; version: number; policy: string } | undefined;
      if (!row) return null;
      const policy = decodePolicy(row.policy, id, row.generation, row.version);
      const binding = storedBinding(db, id as BindingId);
      return binding !== null && binding.generation === row.generation ? policy : null;
    }),

    binding: guarded((bindingId: BindingId): BindingState | null => {
      const binding = storedBinding(db, bindingId);
      return binding === null ? null : { binding, revoked: bindingRevoked(db, binding) };
    }),

    record: guarded((releaseId: ReleaseId) => record(releaseId)),

    releaseFor: guarded((commandId: CommandId): ReleaseId | null => {
      const id = requireIdentifier(commandId);
      const row = db.prepare('SELECT release_id FROM dispatch_records WHERE command_id = ?').get(id) as
        | { release_id: string }
        | undefined;
      return row?.release_id as ReleaseId | undefined ?? null;
    }),

    put: guarded((input: DispatchRecord): void => {
      const next = decodeRecord(input, limits, false);
      const current = record(next.releaseId);
      if (current === null) {
        const row = db.prepare('SELECT job FROM releases WHERE release_id = ?').get(next.releaseId) as
          | { job: string }
          | undefined;
        if (!row) throw new StorageError('invalid_input');
        const decoded = decodeReleasedJob(parseJson(row.job), limits);
        if (!decoded.ok || decoded.value.releaseId !== next.releaseId) throw new StorageError('corrupt');
        if (!sameRelease(decoded.value, next.job)) throw new StorageError('invalid_input');
      } else if (current.seq !== next.seq || !sameRelease(current.job, next.job)) {
        throw new StorageError('invalid_input');
      }
      const sequence = db.prepare('SELECT value FROM dispatch_sequence WHERE singleton = 1').get() as { value: number };
      if (next.seq > sequence.value) throw new StorageError('invalid_input');
      const seqOwner = db.prepare('SELECT release_id FROM dispatch_records WHERE seq = ?').get(next.seq) as
        | { release_id: string }
        | undefined;
      const commandOwner = db.prepare('SELECT release_id FROM dispatch_records WHERE command_id = ?')
        .get(next.job.approval.commandId) as { release_id: string } | undefined;
      if ((seqOwner && seqOwner.release_id !== next.releaseId) || (commandOwner && commandOwner.release_id !== next.releaseId)) {
        throw new StorageError('invalid_input');
      }
      db.prepare(`INSERT INTO dispatch_records (release_id, command_id, seq, state, record) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (release_id) DO UPDATE SET state = excluded.state, record = excluded.record`).run(
        next.releaseId, next.job.approval.commandId, next.seq, next.state, JSON.stringify(next),
      );
    }),

    queued: guarded(() => records("WHERE state = 'queued'").map(item => item.releaseId)),

    active: guarded(() => {
      const list = ACTIVE_STATES.map(() => '?').join(', ');
      return (db.prepare(`SELECT record FROM dispatch_records WHERE state IN (${list}) ORDER BY seq`)
        .all(...ACTIVE_STATES) as { record: string }[]).map(row => storedRecord(row.record, limits));
    }),

    nextSeq: guarded(() => {
      db.prepare('UPDATE dispatch_sequence SET value = value + 1 WHERE singleton = 1').run();
      return (db.prepare('SELECT value FROM dispatch_sequence WHERE singleton = 1').get() as { value: number }).value;
    }),

    causalCount: guarded((root: CausalRootId) => {
      const id = requireIdentifier(root);
      const row = db.prepare('SELECT count FROM dispatch_causal_counts WHERE causal_root_id = ?').get(id) as
        | { count: number }
        | undefined;
      if (row && (!Number.isSafeInteger(row.count) || row.count < 0)) throw new StorageError('corrupt');
      return row?.count ?? 0;
    }),

    setCausalCount: guarded((root: CausalRootId, value: number): void => {
      const id = requireIdentifier(root);
      const count = requireCount(value);
      const current = db.prepare('SELECT count FROM dispatch_causal_counts WHERE causal_root_id = ?').get(id) as
        | { count: number }
        | undefined;
      if (current && count < current.count) throw new StorageError('invalid_input');
      db.prepare(`INSERT INTO dispatch_causal_counts (causal_root_id, count) VALUES (?, ?)
        ON CONFLICT (causal_root_id) DO UPDATE SET count = excluded.count`).run(id, count);
    }),
  };
  return { tx, failed: () => failed };
}

export type EffectivePolicyWriteResult =
  | Readonly<{ kind: 'applied' | 'duplicate' }>
  | Readonly<{ kind: 'conflict'; code: 'binding_unknown' | 'binding_mismatch' | 'revoked' | 'stale_version' | 'version_conflict' }>;

export interface ConnectorDispatchStorage {
  readonly ledger: DispatchLedger;
  /** Called only after trusted controls composition authenticated the policy source. */
  applyEffectivePolicy(input: Readonly<{ binding: SessionBinding; policy: DispatchPolicy }>): Promise<EffectivePolicyWriteResult>;
  readonly approvals: Readonly<{ get(commandId: CommandId): Promise<ApprovalCommand | null> }>;
  readonly payloads: Readonly<{ read(payloadRef: string, maxBytes: number): Promise<Uint8Array | null> }>;
  reconciliationReleaseIds(): Promise<readonly ReleaseId[]>;
}

/** Binds all KHA-121 durable ports to one already-open `ConnectorStorage`. */
export function createConnectorDispatchStorage(storage: ConnectorStorage): ConnectorDispatchStorage {
  const ledger: DispatchLedger = {
    async transact<T>(work: (tx: DispatchTx) => T): Promise<T> {
      const ctx = context(storage);
      let live = true;
      const made = makeTx(storage, () => live && storageInternals.get(storage)?.isOpen() === true);
      try {
        return runTransaction(ctx, () => work(made.tx), () => !made.failed());
      } finally {
        live = false;
      }
    },
  };

  return {
    ledger,

    async applyEffectivePolicy({ binding: inputBinding, policy: inputPolicy }) {
      const decoded = decodeSessionBinding(inputBinding);
      if (!decoded.ok || !usablePolicy(inputPolicy)) throw new StorageError('invalid_input');
      const binding = decoded.value;
      const policy = canonicalPolicy(inputPolicy);
      const ctx = context(storage);
      return runTransaction(ctx, (): EffectivePolicyWriteResult => {
        const currentBinding = storedBinding(ctx.db, binding.bindingId);
        if (currentBinding === null) return { kind: 'conflict', code: 'binding_unknown' };
        if (!sameSessionBinding(currentBinding, binding)) return { kind: 'conflict', code: 'binding_mismatch' };
        if (bindingRevoked(ctx.db, currentBinding)) return { kind: 'conflict', code: 'revoked' };
        const current = ctx.db.prepare(`SELECT generation, version, policy FROM dispatch_policies
          WHERE binding_id = ?`).get(binding.bindingId) as
          | { generation: number; version: number; policy: string }
          | undefined;
        const json = JSON.stringify(policy);
        if (current) {
          decodePolicy(current.policy, binding.bindingId, current.generation, current.version);
          if (policy.version < current.version) return { kind: 'conflict', code: 'stale_version' };
          if (policy.version === current.version) {
            return current.generation === binding.generation && current.policy === json
              ? { kind: 'duplicate' }
              : { kind: 'conflict', code: 'version_conflict' };
          }
        }
        ctx.db.prepare(`INSERT INTO dispatch_policies (binding_id, generation, version, policy) VALUES (?, ?, ?, ?)
          ON CONFLICT (binding_id) DO UPDATE SET generation = excluded.generation,
            version = excluded.version, policy = excluded.policy`).run(
          binding.bindingId, binding.generation, policy.version, json,
        );
        bumpRevision(ctx.db);
        return { kind: 'applied' };
      });
    },

    approvals: {
      async get(commandId) {
        const id = requireIdentifier(commandId);
        const ctx = context(storage);
        return runTransaction(ctx, () => {
          const rows = ctx.db.prepare('SELECT approval_command FROM commands WHERE command_id = ? LIMIT 2')
            .all(id) as { approval_command: string | null }[];
          if (rows.length !== 1 || rows[0]!.approval_command === null) return null;
          const decoded = decodeApprovalCommand(parseJson(rows[0]!.approval_command!), ctx.limits);
          if (!decoded.ok || decoded.value.commandId !== id) throw new StorageError('corrupt');
          return decoded.value;
        });
      },
    },

    payloads: {
      async read(payloadRef, maxBytes) {
        const ref = requireIdentifier(payloadRef);
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new StorageError('invalid_input');
        const ctx = context(storage);
        if (maxBytes > ctx.limits.maxPayloadBytes) throw new StorageError('limit_exceeded');
        return runTransaction(ctx, () => {
          const row = ctx.db.prepare(`SELECT p.digest, length(p.bytes) AS size,
              substr(p.bytes, 1, ?) AS bytes
            FROM payloads p JOIN releases r ON r.payload_ref = p.payload_ref
            WHERE p.payload_ref = ?`).get(maxBytes + 1, ref) as
            | { digest: string; size: number; bytes: Uint8Array }
            | undefined;
          if (!row) return null;
          const bytes = new Uint8Array(row.bytes);
          if (row.size <= maxBytes && (bytes.byteLength !== row.size || sha256Digest(bytes) !== row.digest)) return null;
          return bytes;
        });
      },
    },

    async reconciliationReleaseIds() {
      const ctx = context(storage);
      return runTransaction(ctx, () =>
        (ctx.db.prepare(`SELECT record FROM dispatch_records
          WHERE state IN ('dispatching', 'outcome_unknown') ORDER BY seq`).all() as { record: string }[])
          .map(row => storedRecord(row.record, ctx.limits))
          .map(record => record.releaseId));
    },
  };
}
