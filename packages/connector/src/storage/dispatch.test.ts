// Production dispatch persistence is exercised against the real SQLite ledger. The
// dispatch fixture supplies contract values only; no in-memory ledger participates.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type {
  BindingId, CausalRootId, DeliveryReceiptTransport, DeviceId, ReleaseId,
} from '@khala/contracts/delivery/index';
import { queuedRecord } from '../dispatch/claim';
import { listening, testPolicy } from '../dispatch/fixtures/fakes';
import type { AttemptSnapshot, DispatchPolicy, DispatchRecord } from '../dispatch/types';
import { createConnectorDispatchStorage } from './dispatch';
import {
  agentAcknowledgement, approval, binding, bindingId, commandRecord, content, eventRef, limits, pendingInput, receipt,
  release, scratchDirectory,
} from './fixtures/fakes';
import type { ConnectorStorage } from './open';
import { openConnectorStorage } from './open';
import { LEDGER_FILE } from './leases';
import { recoverConnectorStorage } from './recovery';
import { SCHEMA_VERSION } from './schema';

const opened: ConnectorStorage[] = [];
const scratch: string[] = [];
const getuid = Object.getOwnPropertyDescriptor(process, 'getuid');
const getgid = Object.getOwnPropertyDescriptor(process, 'getgid');

beforeAll(() => {
  // The managed test workspace has synthetic ancestor ownership. Path ownership
  // is covered by open.test.ts; this suite exercises durable dispatch semantics.
  Object.defineProperty(process, 'getuid', { configurable: true, value: undefined });
  Object.defineProperty(process, 'getgid', { configurable: true, value: undefined });
});

afterAll(() => {
  if (getuid) Object.defineProperty(process, 'getuid', getuid);
  if (getgid) Object.defineProperty(process, 'getgid', getgid);
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map(storage => storage.close()));
  for (const directory of scratch.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function fresh() {
  const { parent, state } = scratchDirectory();
  scratch.push(parent);
  const storage = await openConnectorStorage({ directory: state, mode: 'create', limits });
  opened.push(storage);
  await storage.ledger.transaction(tx => tx.putBinding(binding(0)));
  return { state, storage };
}

async function reopen(storage: ConnectorStorage, state: string) {
  await storage.close();
  const reopened = await openConnectorStorage({ directory: state, mode: 'existing', limits });
  opened.push(reopened);
  return reopened;
}

async function durableRelease(storage: ConnectorStorage, releaseId: string, root = `cause-${releaseId}`) {
  const eventId = `event-${releaseId}`;
  const body = `payload for ${releaseId}`;
  await storage.persistPending(pendingInput(eventId, body));
  const command = approval(`approve-${releaseId}`, [eventRef(eventId, body)]);
  const payload = content(body);
  const created = release(command, binding(0), payload, releaseId);
  const job = { ...created, causalRootId: root as CausalRootId };
  const revision = await storage.ledger.transaction(tx => tx.ledgerRevision());
  const result = await storage.ledger.transaction(tx => tx.putRelease({
    command: commandRecord(command, job.releaseId), job, payload, expectedLedgerRevision: revision,
  }));
  expect(result).toEqual({ kind: 'committed' });
  return { approval: command, job, payload };
}

function hasCommandIdLeadingIndex(state: string): boolean {
  const db = new DatabaseSync(path.join(state, LEDGER_FILE), { readOnly: true });
  try {
    const indexes = db.prepare('PRAGMA index_list(commands)').all() as { name: string }[];
    return indexes.some(({ name }) => {
      const columns = db.prepare(`PRAGMA index_info('${name.replaceAll("'", "''")}')`).all() as
        { seqno: number; name: string }[];
      return columns.some(column => column.seqno === 0 && column.name === 'command_id');
    });
  } finally {
    db.close();
  }
}

function storedDispatchRecord(state: string, releaseId: string): string | undefined {
  const db = new DatabaseSync(path.join(state, LEDGER_FILE), { readOnly: true });
  try {
    return (db.prepare('SELECT record FROM dispatch_records WHERE release_id = ?').get(releaseId) as
      | { record: string }
      | undefined)?.record;
  } finally {
    db.close();
  }
}

/** A copy of `value` without `keys`, typed as the original so a writer sees the malformed shape. */
function without<T extends object>(value: T, ...keys: string[]): T {
  const copy = { ...value } as Record<string, unknown>;
  for (const key of keys) delete copy[key];
  return copy as T;
}

function snapshotFor(job: Awaited<ReturnType<typeof durableRelease>>['job']): AttemptSnapshot {
  return {
    modeAtClaim: 'sync',
    bindingGeneration: job.binding.generation,
    sessionId: job.binding.sessionId,
    harness: job.binding.harness,
    harnessVersion: '0.154.0',
    adapterVersion: 'test-adapter',
    route: 'test-codex-interactive-sync',
    evidenceRevision: 'evidence-rev-1',
  };
}

function receiptPair(job: Awaited<ReturnType<typeof durableRelease>>['job']) {
  return [
    {
      ...receipt(job.releaseId, 'harness_queued', job.binding.generation, `receipt-${job.releaseId}-queued`),
      bindingId: job.binding.bindingId,
      observedAt: '2026-09-18T10:10:00.000Z',
      source: 'harness' as const,
      evidenceRef: `codex:userMessage:${job.releaseId}`,
    },
    {
      ...agentAcknowledgement(job.releaseId, `receipt-${job.releaseId}-acknowledged`),
      bindingId: job.binding.bindingId,
      generation: job.binding.generation,
      observedAt: '2026-09-18T10:11:00.000Z',
      evidenceRef: `ack:${job.releaseId}`,
    },
  ] as const;
}

describe('durable dispatch storage', () => {
  it('preserves mixed-version dispatch receipts across restart', async () => {
    const { state, storage } = await fresh();
    let dispatch = createConnectorDispatchStorage(storage);
    const durable = await durableRelease(storage, 'dispatch-mixed-receipts');
    const receipts = receiptPair(durable.job);
    const expected = await dispatch.ledger.transact(tx => {
      const record: DispatchRecord = {
        ...queuedRecord(durable.job, tx.nextSeq()),
        state: 'accepted',
        attemptId: 'attempt-mixed-receipts',
        workerId: 'worker-before-restart',
        claimedAt: '2026-09-18T10:09:00.000Z',
        receipts,
        snapshot: snapshotFor(durable.job),
        reserved: true,
      };
      tx.put(record);
      return record;
    });
    await storage.close();
    const before = storedDispatchRecord(state, durable.job.releaseId);
    expect(before).toBeDefined();
    const reopened = await openConnectorStorage({ directory: state, mode: 'existing', limits });
    opened.push(reopened);
    dispatch = createConnectorDispatchStorage(reopened);
    expect(await dispatch.ledger.transact(tx => tx.record(durable.job.releaseId))).toEqual(expected);
    await reopened.close();
    expect(storedDispatchRecord(state, durable.job.releaseId)).toBe(before);
  });

  it('rejects invalid v2 acknowledgement pairings in durable records', async () => {
    const { storage } = await fresh();
    const dispatch = createConnectorDispatchStorage(storage);
    const durable = await durableRelease(storage, 'dispatch-invalid-ack');
    const [, acknowledgement] = receiptPair(durable.job);
    const invalid = { ...acknowledgement, source: 'harness' } as unknown as DeliveryReceiptTransport;

    await expect(dispatch.ledger.transact(tx => {
      tx.put({
        ...queuedRecord(durable.job, tx.nextSeq()),
        state: 'accepted',
        attemptId: 'attempt-invalid-ack',
        workerId: 'worker-invalid-ack',
        claimedAt: '2026-09-18T10:09:00.000Z',
        receipts: [invalid],
      });
    })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await dispatch.ledger.transact(tx => tx.record(durable.job.releaseId))).toBeNull();
  });

  it('fences dispatch adapters after a device identity conflict', async () => {
    const { storage } = await fresh();
    const identity = { deviceId: 'device_connector_b' as DeviceId, fingerprint: 'device-fingerprint-1' };
    expect(await storage.bindDeviceIdentity(identity)).toEqual({ kind: 'bound' });
    expect(await storage.bindDeviceIdentity({ ...identity, fingerprint: 'device-fingerprint-2' }))
      .toEqual({ kind: 'conflict', code: 'identity_mismatch' });

    const dispatch = createConnectorDispatchStorage(storage);
    await expect(dispatch.ledger.transact(tx => tx.nextSeq()))
      .rejects.toMatchObject({ code: 'identity_mismatch' });
    await expect(dispatch.reconciliationReleaseIds()).rejects.toMatchObject({ code: 'identity_mismatch' });
  });

  it('persists every DispatchTx value in queue order across restart', async () => {
    const { state, storage } = await fresh();
    let dispatch = createConnectorDispatchStorage(storage);
    const policy = testPolicy({ version: 4, armedAt: 3 });
    expect(await dispatch.applyEffectivePolicy({ binding: binding(0), policy })).toEqual({ kind: 'applied' });

    const first = await durableRelease(storage, 'dispatch-release-1');
    const second = await durableRelease(storage, 'dispatch-release-2', 'cause-2');
    await dispatch.ledger.transact(tx => {
      tx.put(queuedRecord(first.job, tx.nextSeq()));
      tx.put(queuedRecord(second.job, tx.nextSeq()));
      tx.setCausalCount(first.job.causalRootId, 2);
    });

    const reopened = await reopen(storage, state);
    dispatch = createConnectorDispatchStorage(reopened);
    expect(await dispatch.ledger.transact(tx => tx.policy(bindingId))).toEqual(policy);
    expect(await dispatch.ledger.transact(tx => tx.binding(bindingId))).toEqual({ binding: binding(0), revoked: false });
    expect(await dispatch.ledger.transact(tx => tx.queued())).toEqual([first.job.releaseId, second.job.releaseId]);
    expect(await dispatch.ledger.transact(tx => tx.releaseFor(second.job.approval.commandId))).toBe(second.job.releaseId);
    expect(await dispatch.ledger.transact(tx => tx.causalCount(first.job.causalRootId))).toBe(2);
    expect(await dispatch.ledger.transact(tx => tx.nextSeq())).toBe(3);
  });

  it('indexes command-id lookup in a fresh ledger', async () => {
    const { state, storage } = await fresh();
    await storage.close();
    expect(hasCommandIdLeadingIndex(state)).toBe(true);
  });

  it('rolls back writes on throw and rejects asynchronous transaction work', async () => {
    const { storage } = await fresh();
    const { ledger } = createConnectorDispatchStorage(storage);
    const first = await durableRelease(storage, 'dispatch-release-rollback');
    await expect(ledger.transact(tx => {
      tx.put(queuedRecord(first.job, tx.nextSeq()));
      tx.setCausalCount(first.job.causalRootId, 7);
      throw new Error('abort dispatch transaction');
    })).rejects.toThrow('abort dispatch transaction');
    expect(await ledger.transact(tx => [tx.record(first.job.releaseId), tx.causalCount(first.job.causalRootId), tx.nextSeq()]))
      .toEqual([null, 0, 1]);

    const second = await durableRelease(storage, 'dispatch-release-async');
    await expect(ledger.transact(async tx => {
      tx.put(queuedRecord(second.job, tx.nextSeq()));
    })).rejects.toMatchObject({ code: 'async_transaction' });
    expect(await ledger.transact(tx => tx.record(second.job.releaseId))).toBeNull();
  });

  it('enforces exact binding, monotonic policy versions, replay, and terminal revocation', async () => {
    const { storage } = await fresh();
    const dispatch = createConnectorDispatchStorage(storage);
    const policy = testPolicy({ version: 3, armedAt: 3 });
    expect(await dispatch.applyEffectivePolicy({ binding: binding(0), policy })).toEqual({ kind: 'applied' });
    expect(await dispatch.applyEffectivePolicy({ binding: binding(0), policy })).toEqual({ kind: 'duplicate' });
    expect(await dispatch.applyEffectivePolicy({ binding: binding(0), policy: { ...policy, version: 2, armedAt: 2 } }))
      .toEqual({ kind: 'conflict', code: 'stale_version' });
    expect(await dispatch.applyEffectivePolicy({ binding: binding(0), policy: { ...policy, paused: true } }))
      .toEqual({ kind: 'conflict', code: 'version_conflict' });
    expect(await dispatch.applyEffectivePolicy({ binding: binding(1), policy: { ...policy, version: 4 } }))
      .toEqual({ kind: 'conflict', code: 'binding_mismatch' });

    await storage.ledger.transaction(tx => tx.putRevocation({
      targetKind: 'binding', targetId: bindingId, generation: 0,
      operationId: 'revoke-dispatch-binding', revokedAt: '2026-09-18T10:03:00Z',
    }));
    expect(await dispatch.applyEffectivePolicy({ binding: binding(0), policy: { ...policy, version: 4 } }))
      .toEqual({ kind: 'conflict', code: 'revoked' });
    expect(await dispatch.ledger.transact(tx => tx.binding(bindingId))).toEqual({ binding: binding(0), revoked: true });
  });

  it('does not reuse an older generation policy after binding replacement', async () => {
    const { storage } = await fresh();
    const dispatch = createConnectorDispatchStorage(storage);
    const policy = testPolicy({ version: 3, armedAt: 3 });
    expect(await dispatch.applyEffectivePolicy({ binding: binding(0), policy })).toEqual({ kind: 'applied' });

    await storage.ledger.transaction(tx => tx.putBinding(binding(1)));

    expect(await dispatch.ledger.transact(tx => tx.policy(bindingId))).toBeNull();
    const replacementPolicy = testPolicy({ version: 4, armedAt: 4 });
    expect(await dispatch.applyEffectivePolicy({ binding: binding(1), policy: replacementPolicy }))
      .toEqual({ kind: 'applied' });
    expect(await dispatch.ledger.transact(tx => tx.policy(bindingId))).toEqual(replacementPolicy);
  });

  it('looks up only durable decoded approvals and bounds released payload reads', async () => {
    const { state, storage } = await fresh();
    await storage.persistPending(pendingInput('event-dispatch', 'review me'));
    const command = approval('command-dispatch', [eventRef('event-dispatch', 'review me')]);
    const payload = content('released bytes');
    const job = release(command, binding(0), payload, 'release-dispatch');
    const revision = await storage.ledger.transaction(tx => tx.ledgerRevision());
    expect(await storage.ledger.transaction(tx => tx.putRelease({
      command: commandRecord(command, job.releaseId), job, payload, expectedLedgerRevision: revision,
    }))).toEqual({ kind: 'committed' });

    const reopened = await reopen(storage, state);
    const dispatch = createConnectorDispatchStorage(reopened);
    expect(await dispatch.approvals.get(command.commandId)).toEqual(command);
    expect(await dispatch.approvals.get('missing-command' as typeof command.commandId)).toBeNull();
    expect(await dispatch.payloads.read(job.payloadRef, 4)).toEqual(payload.subarray(0, 5));
    expect(await dispatch.payloads.read(job.payloadRef, payload.byteLength)).toEqual(payload);
    expect(await dispatch.payloads.read('missing-payload', 4)).toBeNull();
  });

  it('does not expose a pending payload before a release row exists', async () => {
    const { state, storage } = await fresh();
    const pending = pendingInput('event-pending-only', 'pending plaintext');
    expect(await storage.persistPending(pending)).toEqual({ kind: 'inserted' });

    await storage.close();
    const db = new DatabaseSync(path.join(state, LEDGER_FILE), { readOnly: true });
    const row = db.prepare('SELECT payload_ref FROM pending WHERE event_id = ?')
      .get(pending.event.eventId) as { payload_ref: string } | undefined;
    db.close();
    expect(row).toBeDefined();

    const reopened = await openConnectorStorage({ directory: state, mode: 'existing', limits });
    opened.push(reopened);
    const dispatch = createConnectorDispatchStorage(reopened);
    await expect(dispatch.payloads.read(row!.payload_ref, limits.maxPayloadBytes)).resolves.toBeNull();
  });

  it('migrates a v1 ledger without losing pending or release state', async () => {
    const { state, storage } = await fresh();
    await storage.persistPending(pendingInput('event-migrate', 'preserve me'));
    const command = approval('command-migrate', [eventRef('event-migrate', 'preserve me')]);
    const payload = content('migration release bytes');
    const job = release(command, binding(0), payload, 'release-migrate');
    const revision = await storage.ledger.transaction(tx => tx.ledgerRevision());
    expect(await storage.ledger.transaction(tx => tx.putRelease({
      command: commandRecord(command, job.releaseId), job, payload, expectedLedgerRevision: revision,
    }))).toEqual({ kind: 'committed' });
    await storage.close();

    const db = new DatabaseSync(path.join(state, LEDGER_FILE));
    db.exec(`
      DROP TABLE receipt_outbox;
      DROP TABLE harness_route_selections;
      DROP TABLE dispatch_sequence;
      DROP TABLE dispatch_causal_counts;
      DROP TABLE dispatch_records;
      DROP TABLE dispatch_policies;
      DROP TABLE bootstrap_signer;
      DROP TABLE bootstrap_operations;
      DROP INDEX commands_command_id;
      ALTER TABLE commands DROP COLUMN approval_command;
      PRAGMA user_version = 1;
    `);
    db.close();

    const migrated = await openConnectorStorage({ directory: state, mode: 'existing', limits });
    opened.push(migrated);
    expect((await recoverConnectorStorage(migrated)).schemaVersion).toBe(SCHEMA_VERSION);
    expect(await migrated.ledger.transaction(tx => tx.readRelease(job.releaseId))).not.toBeNull();
    expect(await migrated.readReleasedPayload(job.payloadRef)).toEqual(payload);
    await migrated.close();
    expect(hasCommandIdLeadingIndex(state)).toBe(true);
    const reopened = await openConnectorStorage({ directory: state, mode: 'existing', limits });
    opened.push(reopened);
    // V1 did not retain the exact command. Dispatch refuses to fabricate one.
    expect(await createConnectorDispatchStorage(reopened).approvals.get(command.commandId)).toBeNull();
  });

  it('enumerates only claimed, dispatching and outcome-unknown records for restart reconciliation', async () => {
    const { state, storage } = await fresh();
    let dispatch = createConnectorDispatchStorage(storage);
    const states: DispatchRecord['state'][] = [
      'queued', 'claimed', 'dispatching', 'outcome_unknown', 'completed', 'rejected',
    ];
    const releases: Awaited<ReturnType<typeof durableRelease>>[] = [];
    for (const [index, stateValue] of states.entries()) {
      releases.push(await durableRelease(storage, `reconcile-${stateValue}`, `root-${index}`));
    }
    await dispatch.ledger.transact(tx => {
      for (const [index, stateValue] of states.entries()) {
        const releaseValue = releases[index]!;
        const base = queuedRecord(releaseValue.job, tx.nextSeq());
        const claimed = stateValue === 'claimed' || stateValue === 'dispatching' || stateValue === 'outcome_unknown';
        tx.put({
          ...base,
          state: stateValue,
          attemptId: claimed ? `attempt-${index}` : null,
          workerId: claimed ? 'worker-before-crash' : null,
          claimedAt: claimed ? '2026-09-18T10:02:00Z' : null,
          snapshot: claimed ? snapshotFor(releaseValue.job) : null,
          reserved: claimed || stateValue === 'completed',
        });
      }
    });

    await storage.close();
    const db = new DatabaseSync(path.join(state, LEDGER_FILE));
    db.prepare("UPDATE dispatch_records SET record = 'malformed terminal record' WHERE state = 'completed'").run();
    db.close();
    const reopened = await openConnectorStorage({ directory: state, mode: 'existing', limits });
    opened.push(reopened);
    dispatch = createConnectorDispatchStorage(reopened);
    expect(await dispatch.reconciliationReleaseIds()).toEqual([
      'reconcile-claimed' as ReleaseId,
      'reconcile-dispatching' as ReleaseId,
      'reconcile-outcome_unknown' as ReleaseId,
    ]);
    expect(await dispatch.ledger.transact(tx => tx.active()).then(records => records.map(record => record.releaseId)))
      .toEqual(['reconcile-claimed', 'reconcile-dispatching', 'reconcile-outcome_unknown']);
  });

  it('queues only the exact durable release while preserving matching record updates', async () => {
    const { storage } = await fresh();
    const dispatch = createConnectorDispatchStorage(storage);
    const durable = await durableRelease(storage, 'dispatch-exact-release');
    const other = await durableRelease(storage, 'dispatch-other-release');

    const mixedJob = { ...other.job, releaseId: durable.job.releaseId };
    await expect(dispatch.ledger.transact(tx => {
      tx.put(queuedRecord(mixedJob, tx.nextSeq()));
    })).rejects.toMatchObject({ code: 'invalid_input' });
    const unknownJob = { ...durable.job, releaseId: 'dispatch-unknown-release' as ReleaseId };
    await expect(dispatch.ledger.transact(tx => {
      tx.put(queuedRecord(unknownJob, tx.nextSeq()));
    })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await dispatch.ledger.transact(tx => tx.queued())).toEqual([]);

    await dispatch.ledger.transact(tx => {
      const record = queuedRecord(durable.job, tx.nextSeq());
      tx.put(record);
      tx.put({ ...record, reason: 'paused' });
    });
    expect(await dispatch.ledger.transact(tx => tx.record(durable.job.releaseId))).toMatchObject({ reason: 'paused' });
  });

  it('fails closed on duplicate approval IDs, malformed records, and invalid payload bounds', async () => {
    const { storage } = await fresh();
    const dispatch = createConnectorDispatchStorage(storage);
    const releaseOne = await durableRelease(storage, 'dispatch-duplicate-1');
    const durableTwo = await durableRelease(storage, 'dispatch-duplicate-2');
    const releaseTwo = {
      ...durableTwo.job,
      approval: releaseOne.job.approval,
    };
    await expect(dispatch.ledger.transact(tx => {
      tx.put(queuedRecord(releaseOne.job, tx.nextSeq()));
      tx.put(queuedRecord(releaseTwo, tx.nextSeq()));
    })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await dispatch.ledger.transact(tx => tx.queued())).toEqual([]);
    await expect(dispatch.payloads.read('payload-ref', -1)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await dispatch.ledger.transact(tx => tx.binding('missing-binding' as BindingId))).toBeNull();
  });
});

describe('listening-mode dispatch persistence', () => {
  function claimedRecord(job: Awaited<ReturnType<typeof durableRelease>>['job'], seq: number): DispatchRecord {
    return {
      ...queuedRecord(job, seq),
      state: 'claimed',
      attemptId: 'attempt-claimed',
      workerId: 'worker-before-restart',
      claimedAt: '2026-09-18T10:02:00Z',
      snapshot: snapshotFor(job),
      reserved: true,
    };
  }

  it('round-trips a scheduler claim snapshot and its reservation across restart', async () => {
    const { state, storage } = await fresh();
    let dispatch = createConnectorDispatchStorage(storage);
    const durable = await durableRelease(storage, 'dispatch-claimed');
    const expected = await dispatch.ledger.transact(tx => {
      const record = claimedRecord(durable.job, tx.nextSeq());
      tx.put(record);
      return record;
    });
    const reopened = await reopen(storage, state);
    dispatch = createConnectorDispatchStorage(reopened);
    expect(await dispatch.ledger.transact(tx => tx.record(durable.job.releaseId))).toEqual(expected);
    // A requeued pre-effect claim keeps its reservation marker through restart as well.
    const requeued = { ...expected, state: 'queued' as const, reason: 'route_drift' as const,
      attemptId: null, workerId: null, claimedAt: null, snapshot: null };
    await dispatch.ledger.transact(tx => tx.put(requeued));
    const again = await reopen(reopened, state);
    expect(await createConnectorDispatchStorage(again).ledger.transact(tx => tx.record(durable.job.releaseId)))
      .toEqual(requeued);
  });

  it.each([
    ['a claim without a snapshot', (record: DispatchRecord) => ({ ...record, snapshot: null })],
    ['a claim without its reservation', (record: DispatchRecord) => ({ ...record, reserved: false })],
    ['a snapshot missing a field', (record: DispatchRecord) => ({
      ...record, snapshot: without(record.snapshot!, 'route'),
    })],
    ['a snapshot with an unknown field', (record: DispatchRecord) => ({
      ...record, snapshot: { ...record.snapshot!, maxCausalDepth: 3 } as AttemptSnapshot,
    })],
    ['an async modeAtClaim', (record: DispatchRecord) => ({
      ...record, snapshot: { ...record.snapshot!, modeAtClaim: 'async' } as unknown as AttemptSnapshot,
    })],
    ['a snapshot for another session', (record: DispatchRecord) => ({
      ...record, snapshot: { ...record.snapshot!, sessionId: 'thread-replacement' },
    })],
    ['a snapshot for another generation', (record: DispatchRecord) => ({
      ...record, snapshot: { ...record.snapshot!, bindingGeneration: 1 },
    })],
    ['a queued record with a snapshot', (record: DispatchRecord) => ({ ...record, state: 'queued' as const,
      attemptId: null, workerId: null, claimedAt: null })],
    ['a record without the listening fields', (record: DispatchRecord) => without(record, 'snapshot', 'reserved')],
  ])('refuses to write %s', async (_, corrupt) => {
    const { storage } = await fresh();
    const dispatch = createConnectorDispatchStorage(storage);
    const durable = await durableRelease(storage, 'dispatch-malformed-snapshot');
    await expect(dispatch.ledger.transact(tx => tx.put(corrupt(claimedRecord(durable.job, tx.nextSeq())))))
      .rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('reads records stored before listening modes as snapshot-less and never deliverable', async () => {
    const { state, storage } = await fresh();
    const dispatch = createConnectorDispatchStorage(storage);
    const queued = await durableRelease(storage, 'dispatch-legacy-queued', 'root-legacy-queued');
    const inFlight = await durableRelease(storage, 'dispatch-legacy-dispatching', 'root-legacy-dispatching');
    await dispatch.ledger.transact(tx => {
      tx.put(queuedRecord(queued.job, tx.nextSeq()));
      tx.put({ ...claimedRecord(inFlight.job, tx.nextSeq()), state: 'dispatching' });
    });
    await storage.close();
    // Rewrite both rows in the pre-listening-mode shape.
    const db = new DatabaseSync(path.join(state, LEDGER_FILE));
    for (const row of db.prepare('SELECT release_id, record FROM dispatch_records').all() as
      { release_id: string; record: string }[]) {
      const legacy = without(JSON.parse(row.record) as DispatchRecord, 'snapshot', 'reserved');
      db.prepare('UPDATE dispatch_records SET record = ? WHERE release_id = ?').run(JSON.stringify(legacy), row.release_id);
    }
    db.close();
    const reopened = await openConnectorStorage({ directory: state, mode: 'existing', limits });
    opened.push(reopened);
    const legacy = createConnectorDispatchStorage(reopened);
    expect(await legacy.ledger.transact(tx => tx.record(queued.job.releaseId)))
      .toMatchObject({ state: 'queued', snapshot: null, reserved: false });
    expect(await legacy.ledger.transact(tx => tx.record(inFlight.job.releaseId)))
      .toMatchObject({ state: 'dispatching', snapshot: null, reserved: true });
    expect(await legacy.reconciliationReleaseIds()).toEqual([inFlight.job.releaseId]);
  });

  it('blocks dispatch on a policy stored before listening modes until a projection is applied', async () => {
    const { state, storage } = await fresh();
    const dispatch = createConnectorDispatchStorage(storage);
    const policy = testPolicy({ version: 3, armedAt: 3 });
    expect(await dispatch.applyEffectivePolicy({ binding: binding(0), policy })).toEqual({ kind: 'applied' });
    await storage.close();
    const db = new DatabaseSync(path.join(state, LEDGER_FILE));
    // The shape main stored before listening modes, with the per-binding limits it carried then.
    const stored = { ...without(policy, 'listening'), maxJobsPerCausalRoot: 99, maxConcurrentJobs: 99, busy: 'queue' };
    db.prepare('UPDATE dispatch_policies SET policy = ?').run(JSON.stringify(stored));
    db.close();
    const reopened = await openConnectorStorage({ directory: state, mode: 'existing', limits });
    opened.push(reopened);
    const legacy = createConnectorDispatchStorage(reopened);
    expect(await legacy.ledger.transact(tx => tx.policy(bindingId))).toBeNull();
    // A new write may not carry limits either: those come only from the dispatcher's injected profile.
    const withLimits = { ...policy, version: 4, maxConcurrentJobs: 10, busy: 'queue' } as unknown as DispatchPolicy;
    await expect(legacy.applyEffectivePolicy({ binding: binding(0), policy: withLimits }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    expect(await legacy.applyEffectivePolicy({ binding: binding(0), policy: { ...policy, version: 4 } }))
      .toEqual({ kind: 'applied' });
    expect(await legacy.ledger.transact(tx => tx.policy(bindingId))).toEqual({ ...policy, version: 4 });
  });

  it('advances policy and listening-mode versions independently and never moves either back', async () => {
    const { storage } = await fresh();
    const dispatch = createConnectorDispatchStorage(storage);
    const policy = testPolicy({ version: 3, armedAt: 3, listening: listening('sync', { version: 2 }) });
    const apply = (next: DispatchPolicy) => dispatch.applyEffectivePolicy({ binding: binding(0), policy: next });
    expect(await apply(policy)).toEqual({ kind: 'applied' });
    // A listening-mode change alone, at the same policy version.
    const asyncMode = { ...policy, listening: listening('async', { version: 3 }) };
    expect(await apply(asyncMode)).toEqual({ kind: 'applied' });
    expect(await apply(asyncMode)).toEqual({ kind: 'duplicate' });
    // A pause alone, at the same listening version.
    const paused = { ...asyncMode, version: 4, paused: true };
    expect(await apply(paused)).toEqual({ kind: 'applied' });
    // A newer policy carrying an older listening projection cannot overwrite the newer mode.
    expect(await apply({ ...paused, version: 5, listening: listening('sync', { version: 2 }) }))
      .toEqual({ kind: 'conflict', code: 'stale_version' });
    // Different content under an already-applied listening version conflicts.
    expect(await apply({ ...paused, version: 5, listening: listening('steer', { version: 3 }) }))
      .toEqual({ kind: 'conflict', code: 'version_conflict' });
    expect(await dispatch.ledger.transact(tx => tx.policy(bindingId))).toEqual(paused);
  });

  it('rejects a policy carrying maxCausalDepth', async () => {
    const { storage } = await fresh();
    const dispatch = createConnectorDispatchStorage(storage);
    const withDepth = { ...testPolicy(), maxCausalDepth: 3 } as unknown as DispatchPolicy;
    await expect(dispatch.applyEffectivePolicy({ binding: binding(0), policy: withDepth }))
      .rejects.toMatchObject({ code: 'invalid_input' });
  });
});
