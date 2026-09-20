// Production dispatch persistence is exercised against the real SQLite ledger. The
// dispatch fixture supplies contract values only; no in-memory ledger participates.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { BindingId, CausalRootId, DeviceId, ReleaseId } from '@khala/contracts/delivery/index';
import { queuedRecord } from '../dispatch/claim';
import { testPolicy } from '../dispatch/fixtures/fakes';
import type { DispatchRecord } from '../dispatch/types';
import { createConnectorDispatchStorage } from './dispatch';
import {
  approval, binding, bindingId, commandRecord, content, eventRef, limits, pendingInput, release, scratchDirectory,
} from './fixtures/fakes';
import type { ConnectorStorage } from './open';
import { openConnectorStorage } from './open';
import { LEDGER_FILE } from './leases';
import { recoverConnectorStorage } from './recovery';
import { SCHEMA_VERSION } from './schema';

const opened: ConnectorStorage[] = [];
const scratch: string[] = [];

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

describe('durable dispatch storage', () => {
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

  it('enumerates only dispatching and outcome-unknown records for restart reconciliation', async () => {
    const { state, storage } = await fresh();
    let dispatch = createConnectorDispatchStorage(storage);
    const states: DispatchRecord['state'][] = ['queued', 'dispatching', 'outcome_unknown', 'completed', 'rejected'];
    const releases: Awaited<ReturnType<typeof durableRelease>>[] = [];
    for (const [index, stateValue] of states.entries()) {
      releases.push(await durableRelease(storage, `reconcile-${stateValue}`, `root-${index}`));
    }
    await dispatch.ledger.transact(tx => {
      for (const [index, stateValue] of states.entries()) {
        const releaseValue = releases[index]!;
        const base = queuedRecord(releaseValue.job, tx.nextSeq());
        const claimed = stateValue === 'dispatching' || stateValue === 'outcome_unknown';
        tx.put({
          ...base,
          state: stateValue,
          attemptId: claimed ? `attempt-${index}` : null,
          workerId: claimed ? 'worker-before-crash' : null,
          claimedAt: claimed ? '2026-09-18T10:02:00Z' : null,
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
      'reconcile-dispatching' as ReleaseId,
      'reconcile-outcome_unknown' as ReleaseId,
    ]);
    expect(await dispatch.ledger.transact(tx => tx.active()).then(records => records.map(record => record.releaseId)))
      .toEqual(['reconcile-dispatching', 'reconcile-outcome_unknown']);
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
