// Ledger invariants against a real on-disk store. Reopening between steps checks what
// was durably committed rather than what an in-memory handle remembers.

import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventRef, ReleaseId } from '@khala/contracts/delivery/index';
import {
  agentAcknowledgement, approval, binding, bindingId, commandRecord, content, eventRef, limits, ownerId, pendingInput, receipt, release,
  scratchDirectory, streamId, unavailableInput,
} from './fixtures/fakes';
import type { DeviceId, ParticipantId } from '@khala/contracts/delivery/index';
import { type ConnectorStorage, openConnectorStorage, storageInternals } from './open';
import { recoverConnectorStorage } from './recovery';

const opened: ConnectorStorage[] = [];
const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map(storage => storage.close()));
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function fresh(maxBytes?: number) {
  const { parent, state } = scratchDirectory();
  scratch.push(parent);
  const storage = await openConnectorStorage({ directory: state, mode: 'create', limits, ...(maxBytes ? { maxBytes } : {}) });
  opened.push(storage);
  return { storage, state };
}

async function reopen(storage: ConnectorStorage, state: string) {
  await storage.close();
  const next = await openConnectorStorage({ directory: state, mode: 'existing', limits });
  opened.push(next);
  return next;
}

function rawDb(storage: ConnectorStorage) {
  const internals = storageInternals.get(storage);
  if (!internals) throw new Error('no internals');
  return internals.ctx.db;
}

async function seedBinding(storage: ConnectorStorage, generation = 0) {
  return storage.ledger.transaction(tx => tx.putBinding(binding(generation)));
}

async function snapshot(storage: ConnectorStorage, selection: readonly EventRef[]) {
  const snap = await storage.ledger.transaction(tx => tx.readApprovalSnapshot({ bindingId, selection }));
  if (snap?.kind !== 'snapshot') throw new Error(`no snapshot: ${snap?.kind ?? 'null'}`);
  return snap;
}

describe('pending items', () => {
  it('stores one review item per event and recipient, replay-safe across restart', async () => {
    const { storage, state } = await fresh();
    await seedBinding(storage);
    expect(await storage.persistPending(pendingInput('event_7', 'hello'))).toEqual({ kind: 'inserted' });
    const reopened = await reopen(storage, state);
    expect(await reopened.persistPending(pendingInput('event_7', 'hello'))).toEqual({ kind: 'duplicate' });

    const snap = await snapshot(reopened, [eventRef('event_7', 'hello')]);
    expect(snap?.pending).toHaveLength(1);
    expect(snap?.pending[0]?.content).toEqual(content('hello'));
    expect((await recoverConnectorStorage(reopened)).pending).toBe(1);
  });

  it('keeps identical text in distinct events distinct', async () => {
    const { storage } = await fresh();
    await seedBinding(storage);
    expect(await storage.persistPending(pendingInput('event_1', 'same'))).toEqual({ kind: 'inserted' });
    expect(await storage.persistPending(pendingInput('event_2', 'same'))).toEqual({ kind: 'inserted' });
    const snap = await snapshot(storage, [eventRef('event_1', 'same'), eventRef('event_2', 'same')]);
    expect(snap?.pending.map(record => record.event.eventId)).toEqual(['event_1', 'event_2']);
  });

  it('quarantines a changed digest, keeps the original and blocks cursor progress', async () => {
    const { storage, state } = await fresh();
    await seedBinding(storage);
    await storage.persistPending(pendingInput('event_7', 'approved text'));
    expect(await storage.commitCursor({ streamId, expectedRevision: 0, opaqueCursor: 'c1' }))
      .toEqual({ kind: 'committed', revision: 1 });

    expect(await storage.persistPending(pendingInput('event_7', 'rewritten text')))
      .toEqual({ kind: 'conflict', code: 'event_digest_mismatch' });
    expect(await storage.commitCursor({ streamId, expectedRevision: 1, opaqueCursor: 'c2' }))
      .toEqual({ kind: 'blocked', code: 'quarantine_unresolved' });
    // The block is scoped to the stream that observed the conflict.
    expect(await storage.commitCursor({ streamId: 'stream_other', expectedRevision: 0, opaqueCursor: 'o1' }))
      .toEqual({ kind: 'committed', revision: 1 });

    const reopened = await reopen(storage, state);
    const snap = await snapshot(reopened, [eventRef('event_7', 'approved text')]);
    expect(snap?.pending[0]?.content).toEqual(content('approved text'));
    expect(await reopened.readCursor(streamId)).toEqual({ revision: 1, opaqueCursor: 'c1' });
    const report = await recoverConnectorStorage(reopened);
    expect(report.quarantined).toBe(1);
    expect(report.blocked).toContain('quarantine_unresolved');
  });

  it('lets the owner resolve a quarantined conflict without adopting its content', async () => {
    const { storage, state } = await fresh();
    await seedBinding(storage);
    await storage.persistPending(pendingInput('event_7', 'approved text'));
    await storage.persistPending(pendingInput('event_7', 'rewritten text'));

    // Re-delivery of the same conflict must not invalidate an open approval snapshot.
    const before = await storage.ledger.transaction(tx => tx.ledgerRevision());
    await storage.persistPending(pendingInput('event_7', 'rewritten text'));
    expect(await storage.ledger.transaction(tx => tx.ledgerRevision())).toBe(before);

    const [entry] = await storage.readQuarantine();
    expect(entry).toMatchObject({ code: 'event_digest_mismatch', resolvedAt: null, key: { eventId: 'event_7' } });
    expect(JSON.stringify(entry)).not.toContain('rewritten');
    const id = entry?.id ?? -1;
    expect(await storage.resolveQuarantine({ id, resolvedAt: '2026-09-18T10:05:00Z' })).toEqual({ kind: 'resolved' });

    const reopened = await reopen(storage, state);
    expect(await reopened.resolveQuarantine({ id, resolvedAt: '2026-09-18T10:06:00Z' })).toEqual({ kind: 'already_resolved' });
    expect(await reopened.resolveQuarantine({ id: id + 100, resolvedAt: '2026-09-18T10:06:00Z' }))
      .toEqual({ kind: 'conflict', code: 'unknown_entry' });
    // Replay after resolution: a distinct terminal answer, so the stream can move past it.
    const revision = await reopened.ledger.transaction(tx => tx.ledgerRevision());
    expect(await reopened.persistPending(pendingInput('event_7', 'rewritten text')))
      .toEqual({ kind: 'conflict_resolved', code: 'event_digest_mismatch' });
    expect(await reopened.ledger.transaction(tx => tx.ledgerRevision())).toBe(revision);
    expect(await reopened.readQuarantine()).toHaveLength(1);
    expect(await reopened.commitCursor({ streamId, expectedRevision: 0, opaqueCursor: 'c1' }))
      .toEqual({ kind: 'committed', revision: 1 });
    const snap = await snapshot(reopened, [eventRef('event_7', 'approved text')]);
    expect(snap?.pending[0]?.content).toEqual(content('approved text'));
    const report = await recoverConnectorStorage(reopened);
    expect(report.quarantined).toBe(0);
    expect(report.blocked).toEqual([]);
  });

  it('refuses malformed input with a closed code', async () => {
    const { storage } = await fresh();
    const input = pendingInput('event_7', 'hello');
    await expect(storage.persistPending({ ...input, event: { ...input.event, contentDigest: 'not-a-digest' } }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(storage.persistPending({ ...input, key: { ...input.key, recipientGeneration: -1 } }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(storage.ledger.transaction(tx => tx.putBinding({ ...binding(0), generation: -1 })))
      .rejects.toMatchObject({ code: 'invalid_input' });
    expect((await recoverConnectorStorage(storage)).pending).toBe(0);
  });

  it('refuses plaintext that does not match its reference', async () => {
    const { storage } = await fresh();
    await seedBinding(storage);
    const input = { ...pendingInput('event_7', 'hello'), plaintext: content('not hello') };
    expect(await storage.persistPending(input)).toEqual({ kind: 'conflict', code: 'content_digest_mismatch' });
    expect((await recoverConnectorStorage(storage)).pending).toBe(0);
  });

  it('refuses oversized plaintext before touching the ledger', async () => {
    const { storage } = await fresh();
    const body = 'x'.repeat(limits.maxPayloadBytes + 1);
    await expect(storage.persistPending(pendingInput('event_big', body))).rejects.toMatchObject({ code: 'limit_exceeded' });
  });

  it('rolls back a failed write and leaves no partial record', async () => {
    const { storage, state } = await fresh(256 * 1024);
    await seedBinding(storage);
    const body = 'y'.repeat(60 * 1024);
    let failure: unknown;
    for (let i = 0; i < 8 && failure === undefined; i += 1) {
      await storage.persistPending(pendingInput(`event_${i}`, body)).catch(error => { failure = error; });
    }
    expect(failure).toMatchObject({ code: 'storage_full' });
    const reopened = await reopen(storage, state);
    const report = await recoverConnectorStorage(reopened);
    expect(report.blocked).toEqual([]);
    expect(report.pending).toBeGreaterThan(0);
    expect(await reopened.readCursor(streamId)).toBeNull();
  });
});

describe('cursors', () => {
  it('advances only by compare-and-set and reports the durable revision', async () => {
    const { storage, state } = await fresh();
    expect(await storage.commitCursor({ streamId: 's', expectedRevision: 0, opaqueCursor: 'a' }))
      .toEqual({ kind: 'committed', revision: 1 });
    // An uncertain acknowledgement is resolved by reading, not by retrying the old CAS.
    const reopened = await reopen(storage, state);
    expect(await reopened.commitCursor({ streamId: 's', expectedRevision: 0, opaqueCursor: 'a' }))
      .toEqual({ kind: 'conflict', code: 'stale_revision', revision: 1 });
    expect(await reopened.readCursor('s')).toEqual({ revision: 1, opaqueCursor: 'a' });
  });
});

describe('bindings', () => {
  it('advances generations and never rewinds', async () => {
    const { storage } = await fresh();
    expect(await seedBinding(storage, 0)).toEqual({ kind: 'inserted' });
    expect(await seedBinding(storage, 0)).toEqual({ kind: 'duplicate' });
    expect(await seedBinding(storage, 1)).toEqual({ kind: 'advanced' });
    expect(await seedBinding(storage, 0)).toEqual({ kind: 'conflict', code: 'stale_generation' });
    const moved = { ...binding(1), sessionId: 'session_other' };
    expect(await storage.ledger.transaction(tx => tx.putBinding(moved))).toEqual({ kind: 'conflict', code: 'binding_mismatch' });
    const stolen = { ...binding(2), ownerId: 'owner_other' as typeof ownerId };
    expect(await storage.ledger.transaction(tx => tx.putBinding(stolen))).toEqual({ kind: 'conflict', code: 'binding_mismatch' });
  });
});

describe('releases', () => {
  async function releasable() {
    const ctx = await fresh();
    await seedBinding(ctx.storage);
    await ctx.storage.persistPending(pendingInput('event_7', 'please review'));
    const command = approval('command_1', [eventRef('event_7', 'please review')]);
    const payload = content('release envelope bytes');
    const job = release(command, binding(0), payload);
    const revision = await ctx.storage.ledger.transaction(tx => tx.ledgerRevision());
    return { ...ctx, command, payload, job, revision };
  }

  it('commits command, payload and job together and replays the result', async () => {
    const { storage, state, command, payload, job, revision } = await releasable();
    const input = { command: commandRecord(command, job.releaseId), job, payload, expectedLedgerRevision: revision };
    expect(await storage.ledger.transaction(tx => tx.putRelease(input))).toEqual({ kind: 'committed' });

    const reopened = await reopen(storage, state);
    expect(await reopened.ledger.transaction(tx => tx.putRelease(input))).toEqual({ kind: 'duplicate' });
    expect(await reopened.readReleasedPayload(job.payloadRef)).toEqual(payload);
    const stored = await reopened.ledger.transaction(tx => tx.readRelease(job.releaseId));
    expect(stored?.job.payloadDigest).toBe(job.payloadDigest);
    expect(await reopened.ledger.transaction(tx => tx.readCommand(ownerId, command.commandId)))
      .toMatchObject({ inputDigest: input.command.inputDigest });
  });

  it('refuses a reused command ID with different input', async () => {
    const { storage, command, payload, job, revision } = await releasable();
    await storage.ledger.transaction(tx => tx.putRelease({
      command: commandRecord(command, job.releaseId), job, payload, expectedLedgerRevision: revision,
    }));
    const changed = commandRecord(command, job.releaseId, `sha256:${'0'.repeat(64)}`);
    expect(await storage.ledger.transaction(tx => tx.putRelease({
      command: changed, job, payload, expectedLedgerRevision: revision + 1,
    }))).toEqual({ kind: 'conflict', code: 'idempotency_conflict' });
  });

  it('refuses a stale snapshot, wrong bytes and an unreviewed payload read', async () => {
    const { storage, command, payload, job, revision } = await releasable();
    const record = commandRecord(command, job.releaseId);
    expect(await storage.ledger.transaction(tx => tx.putRelease({ command: record, job, payload, expectedLedgerRevision: revision - 1 })))
      .toEqual({ kind: 'conflict', code: 'stale_ledger' });
    expect(await storage.ledger.transaction(tx => tx.putRelease({
      command: record, job, payload: content('other bytes'), expectedLedgerRevision: revision,
    }))).toEqual({ kind: 'conflict', code: 'payload_digest_mismatch' });
    await expect(storage.readReleasedPayload(job.payloadRef)).rejects.toMatchObject({ code: 'payload_unavailable' });
  });

  it('releases a pending item at most once', async () => {
    const { storage, state, command, payload, job, revision } = await releasable();
    await storage.ledger.transaction(tx => tx.putRelease({
      command: commandRecord(command, job.releaseId), job, payload, expectedLedgerRevision: revision,
    }));

    const reopened = await reopen(storage, state);
    const next = await reopened.ledger.transaction(tx => tx.ledgerRevision());
    const again = approval('command_2', command.selection);
    const rejob = release(again, binding(0), payload, 'release_r8');
    expect(await reopened.ledger.transaction(tx => tx.putRelease({
      command: commandRecord(again, rejob.releaseId), job: rejob, payload, expectedLedgerRevision: next,
    }))).toEqual({ kind: 'conflict', code: 'already_released' });
    expect(await reopened.ledger.transaction(tx => tx.readRelease(rejob.releaseId))).toBeNull();
    expect(await reopened.ledger.transaction(tx => tx.readCommand(ownerId, again.commandId))).toBeNull();
  });

  it('refuses a command record that is not the approval the job names', async () => {
    const { storage, command, payload, job, revision } = await releasable();
    const other = approval('command_other', command.selection);
    expect(await storage.ledger.transaction(tx => tx.putRelease({
      command: commandRecord(other, job.releaseId), job, payload, expectedLedgerRevision: revision,
    }))).toEqual({ kind: 'conflict', code: 'command_mismatch' });
    const foreign = { ...commandRecord(command, job.releaseId), ownerId: 'owner_other' as typeof ownerId };
    expect(await storage.ledger.transaction(tx => tx.putRelease({
      command: foreign, job, payload, expectedLedgerRevision: revision,
    }))).toEqual({ kind: 'conflict', code: 'command_mismatch' });
  });

  it('keeps old-generation items after rebinding and refuses to release them', async () => {
    const { storage, state, command, payload, job } = await releasable();
    await seedBinding(storage, 1);
    const reopened = await reopen(storage, state);
    const revision = await reopened.ledger.transaction(tx => tx.ledgerRevision());

    // The old job names generation 0, which is no longer current.
    expect(await reopened.ledger.transaction(tx => tx.putRelease({
      command: commandRecord(command, job.releaseId), job, payload, expectedLedgerRevision: revision,
    }))).toEqual({ kind: 'conflict', code: 'stale_binding' });

    // A fresh approval for the new generation does not adopt the old pending record.
    const rearmed = approval('command_2', [eventRef('event_7', 'please review')], 1);
    const rejob = release(rearmed, binding(1), payload, 'release_r8');
    expect(await reopened.ledger.transaction(tx => tx.putRelease({
      command: commandRecord(rearmed, rejob.releaseId), job: rejob, payload, expectedLedgerRevision: revision,
    }))).toEqual({ kind: 'conflict', code: 'pending_missing' });

    const report = await recoverConnectorStorage(reopened);
    expect(report.staleGenerationPending).toBe(1);
    expect(report.pending).toBe(1);
    expect((await snapshot(reopened, [eventRef('event_7', 'please review')]))?.pending).toEqual([]);
  });
});

describe('receipts', () => {
  it('preserves mixed receipt versions and immutable duplicates across restart', async () => {
    const { storage, state } = await fresh();
    await seedBinding(storage);
    await storage.persistPending(pendingInput('event_7', 'hi'));
    const command = approval('command_1', [eventRef('event_7', 'hi')]);
    const payload = content('envelope');
    const job = release(command, binding(0), payload);
    const releaseRevision = await storage.ledger.transaction(tx => tx.ledgerRevision());
    await storage.ledger.transaction(tx => tx.putRelease({
      command: commandRecord(command, job.releaseId), job, payload, expectedLedgerRevision: releaseRevision,
    }));

    const v1 = receipt(job.releaseId, 'transport_written');
    const v2 = agentAcknowledgement(job.releaseId);
    const v1Json = JSON.stringify(v1);
    const v2Json = JSON.stringify(v2);

    expect(await storage.ledger.transaction(tx => tx.appendReceipt({ receipt: v1 })))
      .toEqual({ kind: 'recorded', receipt: v1 });
    expect((rawDb(storage).prepare('SELECT receipt FROM receipts WHERE receipt_id = ?').get(v1.receiptId) as { receipt: string }).receipt)
      .toBe(v1Json);

    expect(await storage.ledger.transaction(tx => tx.appendReceipt({ receipt: v2 })))
      .toEqual({ kind: 'recorded', receipt: v2 });
    const storedBeforeRestart = rawDb(storage).prepare('SELECT receipt FROM receipts ORDER BY ledger_revision')
      .all() as { receipt: string }[];
    expect(storedBeforeRestart.map(row => row.receipt)).toEqual([v1Json, v2Json]);

    const afterWrites = await storage.ledger.transaction(tx => tx.ledgerRevision());
    expect(await storage.ledger.transaction(tx => tx.appendReceipt({ receipt: v2 })))
      .toEqual({ kind: 'duplicate', receipt: v2 });
    expect(await storage.ledger.transaction(tx => tx.ledgerRevision())).toBe(afterWrites);
    expect(await storage.ledger.transaction(tx => tx.appendReceipt({
      receipt: { ...v2, observedAt: '2026-09-18T11:00:00Z' },
    }))).toEqual({ kind: 'conflict', code: 'receipt_conflict' });

    const reopened = await reopen(storage, state);
    expect(await reopened.ledger.transaction(tx => tx.readReceipts(job.releaseId))).toEqual([
      { receipt: v1, correlation: 'correlated' },
      { receipt: v2, correlation: 'correlated' },
    ]);
    expect((rawDb(reopened).prepare('SELECT receipt FROM receipts ORDER BY ledger_revision').all() as { receipt: string }[])
      .map(row => row.receipt)).toEqual([v1Json, v2Json]);

    const beforeRestartedDuplicate = await reopened.ledger.transaction(tx => tx.ledgerRevision());
    expect(await reopened.ledger.transaction(tx => tx.appendReceipt({ receipt: v2 })))
      .toEqual({ kind: 'duplicate', receipt: v2 });
    expect(await reopened.ledger.transaction(tx => tx.ledgerRevision())).toBe(beforeRestartedDuplicate);
    expect((rawDb(reopened).prepare('SELECT receipt FROM receipts WHERE receipt_id = ?').get(v2.receiptId) as { receipt: string }).receipt)
      .toBe(v2Json);
  });

  it('records correlated facts once and keeps uncorrelated ones for reconciliation', async () => {
    const { storage } = await fresh();
    await seedBinding(storage);
    await storage.persistPending(pendingInput('event_7', 'hi'));
    const command = approval('command_1', [eventRef('event_7', 'hi')]);
    const payload = content('envelope');
    const job = release(command, binding(0), payload);
    const revision = await storage.ledger.transaction(tx => tx.ledgerRevision());
    await storage.ledger.transaction(tx => tx.putRelease({
      command: commandRecord(command, job.releaseId), job, payload, expectedLedgerRevision: revision,
    }));

    const written = receipt(job.releaseId, 'transport_written');
    expect(await storage.ledger.transaction(tx => tx.appendReceipt({ receipt: written })))
      .toEqual({ kind: 'recorded', receipt: written });
    expect(await storage.ledger.transaction(tx => tx.appendReceipt({ receipt: written })))
      .toEqual({ kind: 'duplicate', receipt: written });
    expect(await storage.ledger.transaction(tx => tx.appendReceipt({ receipt: { ...written, observedAt: '2026-09-18T11:00:00Z' } })))
      .toEqual({ kind: 'conflict', code: 'receipt_conflict' });
    expect(await storage.ledger.transaction(tx => tx.appendReceipt({ receipt: receipt('release_unknown', 'completed', 0, 'receipt_orphan') })))
      .toEqual({ kind: 'conflict', code: 'unknown_release' });
    expect(await storage.ledger.transaction(tx => tx.appendReceipt({ receipt: receipt(job.releaseId, 'completed', 3, 'receipt_wrong_gen') })))
      .toEqual({ kind: 'conflict', code: 'correlation_mismatch' });

    let report = await recoverConnectorStorage(storage);
    expect(report.outcomeUnknownReleases).toEqual([job.releaseId]);
    expect(report.undispatchedReleases).toEqual([]);
    expect(report.uncorrelatedReceipts).toBe(2);

    await storage.ledger.transaction(tx => tx.appendReceipt({ receipt: receipt(job.releaseId, 'completed') }));
    report = await recoverConnectorStorage(storage);
    expect(report.outcomeUnknownReleases).toEqual([]);
    expect(await storage.ledger.transaction(tx => tx.readReceipts(job.releaseId as ReleaseId)
      .map(r => [r.receipt.kind, r.correlation])))
      .toEqual([['transport_written', 'correlated'], ['completed', 'correlation_mismatch'], ['completed', 'correlated']]);
  });
});

describe('transactions', () => {
  it('rolls back everything when the callback throws', async () => {
    const { storage } = await fresh();
    await expect(storage.ledger.transaction(tx => {
      tx.putBinding(binding(0));
      throw new Error('consumer failure');
    })).rejects.toThrow('consumer failure');
    expect(await storage.ledger.transaction(tx => tx.readBinding(bindingId))).toBeNull();
  });

  it('refuses asynchronous work, nesting and use after the transaction', async () => {
    const { storage } = await fresh();
    await expect(storage.ledger.transaction(async tx => tx.putBinding(binding(0))))
      .rejects.toMatchObject({ code: 'async_transaction' });
    expect(await storage.ledger.transaction(tx => tx.readBinding(bindingId))).toBeNull();

    let nested: Promise<unknown> | undefined;
    await storage.ledger.transaction(() => {
      nested = storage.ledger.transaction(tx => tx.ledgerRevision());
    });
    await expect(nested).rejects.toMatchObject({ code: 'nested_transaction' });

    const leaked = await storage.ledger.transaction(tx => tx);
    expect(() => leaked.readBinding(bindingId)).toThrow(expect.objectContaining({ code: 'closed' }));
  });
});

describe('recovery of released jobs', () => {
  async function releasedJob() {
    const ctx = await fresh();
    await seedBinding(ctx.storage);
    await ctx.storage.persistPending(pendingInput('event_7', 'hi'));
    const command = approval('command_1', [eventRef('event_7', 'hi')]);
    const payload = content('envelope');
    const job = release(command, binding(0), payload);
    const revision = await ctx.storage.ledger.transaction(tx => tx.ledgerRevision());
    await ctx.storage.ledger.transaction(tx => tx.putRelease({
      command: commandRecord(command, job.releaseId), job, payload, expectedLedgerRevision: revision,
    }));
    return { ...ctx, job };
  }

  // Listed here rather than imported so dropping a kind from recovery fails a test.
  const evidence = ['dispatching', 'transport_written', 'harness_queued', 'context_consumed', 'outcome_unknown'] as const;

  for (const kind of evidence) {
    it(`treats a correlated ${kind} receipt as an unknown outcome, never undispatched`, async () => {
      const { storage, state, job } = await releasedJob();
      const evidenceReceipt = receipt(job.releaseId, kind);
      expect(await storage.ledger.transaction(tx => tx.appendReceipt({ receipt: evidenceReceipt })))
        .toEqual({ kind: 'recorded', receipt: evidenceReceipt });
      const report = await recoverConnectorStorage(await reopen(storage, state));
      expect(report.outcomeUnknownReleases).toEqual([job.releaseId]);
      expect(report.undispatchedReleases).toEqual([]);
    });
  }

  it('treats an agent acknowledgement as an unknown outcome, never undispatched', async () => {
    const { storage, state, job } = await releasedJob();
    const acknowledgement = agentAcknowledgement(job.releaseId);
    expect(await storage.ledger.transaction(tx => tx.appendReceipt({ receipt: acknowledgement })))
      .toEqual({ kind: 'recorded', receipt: acknowledgement });
    const report = await recoverConnectorStorage(await reopen(storage, state));
    expect(report.outcomeUnknownReleases).toEqual([job.releaseId]);
    expect(report.undispatchedReleases).toEqual([]);
  });

  it('treats an uncorrelated outcome_unknown receipt as dispatch evidence too', async () => {
    const { storage, state, job } = await releasedJob();
    expect(await storage.ledger.transaction(tx => tx.appendReceipt({ receipt: receipt(job.releaseId, 'outcome_unknown', 3) })))
      .toEqual({ kind: 'conflict', code: 'correlation_mismatch' });
    const report = await recoverConnectorStorage(await reopen(storage, state));
    expect(report.outcomeUnknownReleases).toEqual([job.releaseId]);
    expect(report.undispatchedReleases).toEqual([]);
    expect(report.uncorrelatedReceipts).toBe(1);
  });

  it('reports a release with only a queued receipt as undispatched', async () => {
    const { storage, state, job } = await releasedJob();
    await storage.ledger.transaction(tx => tx.appendReceipt({ receipt: receipt(job.releaseId, 'queued') }));
    const report = await recoverConnectorStorage(await reopen(storage, state));
    expect(report.outcomeUnknownReleases).toEqual([]);
    expect(report.undispatchedReleases).toEqual([job.releaseId]);
  });
});

describe('revocation', () => {
  async function revokedSetup(target: 'binding' | 'device') {
    const ctx = await fresh();
    await seedBinding(ctx.storage);
    await ctx.storage.persistPending(pendingInput('event_7', 'please review'));
    const command = approval('command_1', [eventRef('event_7', 'please review')]);
    const payload = content('release envelope bytes');
    const job = release(command, binding(0), payload);
    const revocation = target === 'binding'
      ? { targetKind: 'binding' as const, targetId: bindingId, generation: 0 }
      : { targetKind: 'device' as const, targetId: binding(0).deviceId, generation: 3 };
    const input = { ...revocation, operationId: 'op_revoke_1', revokedAt: '2026-09-18T10:03:00Z' };
    expect(await ctx.storage.ledger.transaction(tx => tx.putRevocation(input))).toEqual({ kind: 'recorded' });
    expect(await ctx.storage.ledger.transaction(tx => tx.putRevocation({ ...input, operationId: 'op_retry' })))
      .toEqual({ kind: 'duplicate' });
    return { ...ctx, command, payload, job };
  }

  for (const target of ['binding', 'device'] as const) {
    it(`refuses every recipient write and release once the ${target} is revoked, across restart`, async () => {
      const { storage, state, command, payload, job } = await revokedSetup(target);
      const reopened = await reopen(storage, state);

      expect(await reopened.persistPending(pendingInput('event_8', 'more'))).toEqual({ kind: 'blocked', code: 'revoked' });
      expect(await reopened.persistUnavailable(unavailableInput('event_9'))).toEqual({ kind: 'blocked', code: 'revoked' });
      expect(await reopened.ledger.transaction(tx => tx.readApprovalSnapshot({ bindingId, selection: command.selection })))
        .toEqual({ kind: 'revoked' });
      const revision = await reopened.ledger.transaction(tx => tx.ledgerRevision());
      expect(await reopened.ledger.transaction(tx => tx.putRelease({
        command: commandRecord(command, job.releaseId), job, payload, expectedLedgerRevision: revision,
      }))).toEqual({ kind: 'conflict', code: 'revoked' });
      expect(await reopened.ledger.transaction(tx => tx.readRelease(job.releaseId))).toBeNull();

      const report = await recoverConnectorStorage(reopened);
      expect(report.blocked).toEqual(['revoked']);
      expect(report.revokedBindings).toEqual([bindingId]);
      expect(report.pending).toBe(1);
    });
  }

  it('keeps a revoked binding ID revoked at every generation', async () => {
    const { storage, state } = await revokedSetup('binding');
    // A revoked binding is never re-armed or rebound: re-bootstrap mints a new binding ID.
    expect(await seedBinding(storage, 1)).toEqual({ kind: 'conflict', code: 'revoked' });
    expect(await storage.ledger.transaction(tx => tx.readBinding(bindingId))).toMatchObject({ generation: 0 });

    // Even a later generation already stored before the revocation stays blocked.
    rawDb(storage).prepare('UPDATE bindings SET generation = 1, binding = ? WHERE binding_id = ?')
      .run(JSON.stringify(binding(1)), bindingId);
    const reopened = await reopen(storage, state);
    expect(await reopened.persistPending(pendingInput('event_8', 'more', 1))).toEqual({ kind: 'blocked', code: 'revoked' });
    expect(await reopened.persistUnavailable(unavailableInput('event_9', 'withheld', 1))).toEqual({ kind: 'blocked', code: 'revoked' });
    expect(await reopened.ledger.transaction(tx => tx.readApprovalSnapshot({ bindingId, selection: [] })))
      .toEqual({ kind: 'revoked' });
    const report = await recoverConnectorStorage(reopened);
    expect(report.revokedBindings).toEqual([bindingId]);
    expect(report.blocked).toEqual(['revoked']);
  });

  it('refuses to bind anything new to a revoked device', async () => {
    const { storage } = await revokedSetup('device');
    expect(await seedBinding(storage, 1)).toEqual({ kind: 'conflict', code: 'revoked' });
  });

  for (const target of ['binding', 'device'] as const) {
    it(`withholds an already released payload once the ${target} is revoked`, async () => {
      const { storage, state } = await fresh();
      await seedBinding(storage);
      await storage.persistPending(pendingInput('event_7', 'please review'));
      const command = approval('command_1', [eventRef('event_7', 'please review')]);
      const payload = content('release envelope bytes');
      const job = release(command, binding(0), payload);
      const revision = await storage.ledger.transaction(tx => tx.ledgerRevision());
      await storage.ledger.transaction(tx => tx.putRelease({
        command: commandRecord(command, job.releaseId), job, payload, expectedLedgerRevision: revision,
      }));
      expect(await storage.readReleasedPayload(job.payloadRef)).toEqual(payload);

      const revocation = target === 'binding'
        ? { targetKind: 'binding' as const, targetId: bindingId }
        : { targetKind: 'device' as const, targetId: binding(0).deviceId };
      await storage.ledger.transaction(tx => tx.putRevocation({
        ...revocation, generation: 0, operationId: 'op_revoke_1', revokedAt: '2026-09-18T10:03:00Z',
      }));
      const reopened = await reopen(storage, state);
      await expect(reopened.readReleasedPayload(job.payloadRef)).rejects.toMatchObject({ code: 'revoked' });
    });
  }

  it('refuses malformed revocations', async () => {
    const { storage } = await fresh();
    const base = { targetKind: 'binding' as const, targetId: bindingId, generation: 0, operationId: 'op_1', revokedAt: '2026-09-18T10:03:00Z' };
    for (const bad of [{ ...base, targetKind: 'room' }, { ...base, generation: -1 }, { ...base, revokedAt: 'yesterday' }, { ...base, operationId: '' }]) {
      await expect(storage.ledger.transaction(tx => tx.putRevocation(bad as typeof base))).rejects.toMatchObject({ code: 'invalid_input' });
    }
  });
});

describe('unavailable placeholders', () => {
  it('holds a withheld event, lets the cursor pass it, then is replaced by the decrypted event', async () => {
    const { storage, state } = await fresh();
    await seedBinding(storage);
    expect(await storage.persistUnavailable(unavailableInput('event_7', 'withheld'))).toEqual({ kind: 'inserted' });
    expect(await storage.persistUnavailable(unavailableInput('event_7', 'withheld'))).toEqual({ kind: 'duplicate' });
    expect(await storage.commitCursor({ streamId, expectedRevision: 0, opaqueCursor: 'after_7' }))
      .toEqual({ kind: 'committed', revision: 1 });

    let reopened = await reopen(storage, state);
    expect(await reopened.ledger.transaction(tx => tx.readPlaceholders(bindingId)))
      .toMatchObject([{ key: { eventId: 'event_7' }, reason: 'withheld' }]);
    expect((await recoverConnectorStorage(reopened)).unavailable).toBe(1);
    // A placeholder is never approvable.
    expect((await snapshot(reopened, [eventRef('event_7', 'finally readable')])).pending).toEqual([]);

    expect(await reopened.persistPending(pendingInput('event_7', 'finally readable'))).toEqual({ kind: 'replaced' });
    reopened = await reopen(reopened, state);
    expect(await reopened.ledger.transaction(tx => tx.readPlaceholders(bindingId))).toEqual([]);
    expect((await snapshot(reopened, [eventRef('event_7', 'finally readable')])).pending[0]?.content)
      .toEqual(content('finally readable'));
    // A late undecryptable replay never downgrades the decrypted record.
    expect(await reopened.persistUnavailable(unavailableInput('event_7', 'decrypt_failed'))).toEqual({ kind: 'duplicate' });
    expect(await reopened.persistPending(pendingInput('event_7', 'finally readable'))).toEqual({ kind: 'duplicate' });
    const report = await recoverConnectorStorage(reopened);
    expect(report).toMatchObject({ unavailable: 0, pending: 1, blocked: [] });
  });

  const misattributed = [
    ['device', { authorDeviceId: 'device_other' as DeviceId }],
    ['participant', { authorParticipantId: 'participant_other' as ParticipantId }],
  ] as const;

  for (const [field, change] of misattributed) {
    it(`quarantines a decrypted event whose author ${field} differs from its placeholder`, async () => {
      const { storage } = await fresh();
      await seedBinding(storage);
      const held = unavailableInput('event_7');
      await storage.persistUnavailable({ ...held, ref: { ...held.ref, ...change } });
      expect(await storage.persistPending(pendingInput('event_7', 'text'))).toEqual({ kind: 'conflict', code: 'event_ref_mismatch' });
      expect(await storage.ledger.transaction(tx => tx.readPlaceholders(bindingId))).toHaveLength(1);
      expect((await recoverConnectorStorage(storage)).pending).toBe(0);
      expect(await storage.commitCursor({ streamId, expectedRevision: 0, opaqueCursor: 'c' }))
        .toEqual({ kind: 'blocked', code: 'quarantine_unresolved' });
    });

    it(`quarantines a placeholder whose author ${field} differs from the stored pending event`, async () => {
      const { storage } = await fresh();
      await seedBinding(storage);
      await storage.persistPending(pendingInput('event_7', 'text'));
      const held = unavailableInput('event_7');
      expect(await storage.persistUnavailable({ ...held, ref: { ...held.ref, ...change } }))
        .toEqual({ kind: 'conflict', code: 'event_ref_mismatch' });
      expect(await storage.ledger.transaction(tx => tx.readPlaceholders(bindingId))).toEqual([]);
      expect((await snapshot(storage, [eventRef('event_7', 'text')])).pending[0]?.content).toEqual(content('text'));
      expect((await recoverConnectorStorage(storage)).quarantined).toBe(1);
    });
  }

  it('keys placeholders by recipient generation and refuses mismatched input', async () => {
    const { storage } = await fresh();
    await seedBinding(storage);
    await storage.persistUnavailable(unavailableInput('event_7'));
    await seedBinding(storage, 1);
    expect(await storage.persistUnavailable(unavailableInput('event_7', 'withheld', 1))).toEqual({ kind: 'inserted' });
    expect(await storage.ledger.transaction(tx => tx.readPlaceholders(bindingId))).toMatchObject([{ key: { recipientGeneration: 1 } }]);
    const input = unavailableInput('event_8');
    await expect(storage.persistUnavailable({ ...input, reason: 'lost' as never })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(storage.persistUnavailable({ ...input, key: { ...input.key, eventId: 'event_9' as never } }))
      .rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('recipient checks', () => {
  it('records events only for a known, current recipient generation', async () => {
    const { storage } = await fresh();
    expect(await storage.persistPending(pendingInput('event_7', 'hi'))).toEqual({ kind: 'blocked', code: 'binding_unknown' });
    await seedBinding(storage, 0);
    expect(await storage.persistPending(pendingInput('event_7', 'hi', 1))).toEqual({ kind: 'blocked', code: 'binding_unknown' });
    await seedBinding(storage, 1);
    expect(await storage.persistPending(pendingInput('event_7', 'hi', 0))).toEqual({ kind: 'blocked', code: 'stale_generation' });
    expect(await storage.persistPending(pendingInput('event_7', 'hi', 1))).toEqual({ kind: 'inserted' });
    expect((await recoverConnectorStorage(storage)).pending).toBe(1);
  });

  it('requires the key to name the same room and event as the reference', async () => {
    const { storage } = await fresh();
    await seedBinding(storage);
    const input = pendingInput('event_7', 'hi');
    await expect(storage.persistPending({ ...input, key: { ...input.key, eventId: 'event_8' as never } }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(storage.persistPending({ ...input, key: { ...input.key, roomId: 'room_2' as never } }))
      .rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('input bounds', () => {
  it('bounds cursors, stream IDs, timestamps and quarantine pages', async () => {
    const { storage } = await fresh();
    await seedBinding(storage);
    await expect(storage.commitCursor({ streamId, expectedRevision: 0, opaqueCursor: 'c'.repeat(8 * 1024 + 1) }))
      .rejects.toMatchObject({ code: 'limit_exceeded' });
    await expect(storage.commitCursor({ streamId: 's'.repeat(513), expectedRevision: 0, opaqueCursor: 'c' }))
      .rejects.toMatchObject({ code: 'limit_exceeded' });
    await expect(storage.commitCursor({ streamId, expectedRevision: -1, opaqueCursor: 'c' }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    for (const receivedAt of ['yesterday', '2026-02-30T00:00:00Z', '2026-09-18T10:00:00+02:00']) {
      await expect(storage.persistPending({ ...pendingInput('event_7', 'hi'), receivedAt })).rejects.toMatchObject({ code: 'invalid_input' });
    }
    await expect(storage.persistPending({ ...pendingInput('event_7', 'hi'), streamId: '' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(storage.resolveQuarantine({ id: 1, resolvedAt: 'now' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(storage.readQuarantine({ limit: 101 })).rejects.toMatchObject({ code: 'limit_exceeded' });
    expect(await recoverConnectorStorage(storage)).toMatchObject({ pending: 0, cursors: [] });
  });

  it('pages quarantine entries', async () => {
    const { storage } = await fresh();
    await seedBinding(storage);
    for (const id of ['event_1', 'event_2', 'event_3']) {
      await storage.persistPending({ ...pendingInput(id, 'hi'), plaintext: content('not hi') });
    }
    const first = await storage.readQuarantine({ limit: 2 });
    expect(first.map(entry => entry.key.eventId)).toEqual(['event_1', 'event_2']);
    const rest = await storage.readQuarantine({ afterId: first[1]!.id, limit: 2 });
    expect(rest.map(entry => entry.key.eventId)).toEqual(['event_3']);
  });

  it('bounds device identity values', async () => {
    const { storage } = await fresh();
    await expect(storage.bindDeviceIdentity({ deviceId: 'device_b' as DeviceId, fingerprint: 'f'.repeat(513) }))
      .rejects.toMatchObject({ code: 'limit_exceeded' });
  });
});

describe('release refusals', () => {
  async function releasable() {
    const ctx = await fresh();
    await seedBinding(ctx.storage);
    await ctx.storage.persistPending(pendingInput('event_7', 'please review'));
    const command = approval('command_1', [eventRef('event_7', 'please review')]);
    const payload = content('release envelope bytes');
    const job = release(command, binding(0), payload);
    const revision = await ctx.storage.ledger.transaction(tx => tx.ledgerRevision());
    const put = (input: Partial<Parameters<Parameters<typeof ctx.storage.ledger.transaction>[0]>[0]['putRelease'] extends (i: infer I) => unknown ? I : never>) =>
      ctx.storage.ledger.transaction(tx => tx.putRelease({
        command: commandRecord(command, job.releaseId), job, payload, expectedLedgerRevision: revision, ...input,
      }));
    return { ...ctx, command, payload, job, revision, put };
  }

  it('refuses a command result that does not name exactly this release', async () => {
    const { put, command, job } = await releasable();
    const record = commandRecord(command, job.releaseId);
    expect(await put({ command: { ...record, result: { ok: true, releaseIds: ['release_other' as ReleaseId] } } }))
      .toEqual({ kind: 'conflict', code: 'invalid_command_result' });
    expect(await put({ command: { ...record, result: { ok: false, code: 'stale_binding' } as never } }))
      .toEqual({ kind: 'conflict', code: 'invalid_command_result' });
  });

  it('refuses a release whose embedded approval provenance differs from its command', async () => {
    const { put, command, job } = await releasable();
    const record = commandRecord(command, job.releaseId);
    const mismatched = {
      ...record,
      command: { ...command, expectedPolicyVersion: command.expectedPolicyVersion + 1 },
    };

    expect(await put({ command: mismatched })).toEqual({ kind: 'conflict', code: 'command_mismatch' });
  });

  it('refuses a job whose event reference differs from the pending record', async () => {
    const { put, payload } = await releasable();
    const changed = { ...eventRef('event_7', 'please review'), authorDeviceId: 'device_z' as DeviceId };
    const command = approval('command_1', [changed]);
    const job = release(command, binding(0), payload);
    expect(await put({ command: commandRecord(command, job.releaseId), job })).toEqual({ kind: 'conflict', code: 'stale_content' });
  });

  it('refuses an oversized payload and a malformed input digest', async () => {
    const { put, command } = await releasable();
    const big = content('z'.repeat(limits.maxPayloadBytes));
    const job = release(command, binding(0), big);
    expect(await put({ command: commandRecord(command, job.releaseId), job, payload: big }))
      .toEqual({ kind: 'conflict', code: 'limit_exceeded' });
    const bad = commandRecord(command, 'release_r7', 'sha256:XYZ');
    await expect(put({ command: bad })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('refuses a release ID or payload handle already used by another release', async () => {
    const { storage, put, job } = await releasable();
    expect(await put({})).toEqual({ kind: 'committed' });
    await storage.persistPending(pendingInput('event_8', 'second'));
    const revision = await storage.ledger.transaction(tx => tx.ledgerRevision());
    const other = approval('command_2', [eventRef('event_8', 'second')]);
    const payload = content('second envelope');
    const sameId = release(other, binding(0), payload, job.releaseId);
    expect(await storage.ledger.transaction(tx => tx.putRelease({
      command: commandRecord(other, sameId.releaseId), job: sameId, payload, expectedLedgerRevision: revision,
    }))).toEqual({ kind: 'conflict', code: 'release_conflict' });
    const sameHandle = { ...release(other, binding(0), payload, 'release_r8'), payloadRef: job.payloadRef };
    expect(await storage.ledger.transaction(tx => tx.putRelease({
      command: commandRecord(other, sameHandle.releaseId), job: sameHandle, payload, expectedLedgerRevision: revision,
    }))).toEqual({ kind: 'conflict', code: 'release_conflict' });
    expect(await storage.ledger.transaction(tx => tx.readCommand(ownerId, other.commandId))).toBeNull();
    expect(await storage.ledger.transaction(tx => tx.readRelease('release_r8' as ReleaseId))).toBeNull();
  });
});

describe('payload integrity', () => {
  async function released() {
    const ctx = await fresh();
    await seedBinding(ctx.storage);
    await ctx.storage.persistPending(pendingInput('event_7', 'please review'));
    const command = approval('command_1', [eventRef('event_7', 'please review')]);
    const payload = content('release envelope bytes');
    const job = release(command, binding(0), payload);
    const revision = await ctx.storage.ledger.transaction(tx => tx.ledgerRevision());
    await ctx.storage.ledger.transaction(tx => tx.putRelease({
      command: commandRecord(command, job.releaseId), job, payload, expectedLedgerRevision: revision,
    }));
    return { ...ctx, job, payload };
  }

  it('resolves only released payload handles, never pending ones', async () => {
    const { storage, job, payload } = await released();
    expect(await storage.readReleasedPayload(job.payloadRef)).toEqual(payload);
    const { payload_ref: pendingRef } = rawDb(storage).prepare('SELECT payload_ref FROM pending').get() as { payload_ref: string };
    expect(await storage.ledger.transaction(tx => tx.readPayloadReferences(pendingRef))).toEqual({ pending: 1, releases: 0 });
    await expect(storage.readReleasedPayload(pendingRef)).rejects.toMatchObject({ code: 'payload_unavailable' });
  });

  it('reports damaged bytes as unavailable, never as altered content', async () => {
    const { storage, state, job } = await released();
    rawDb(storage).prepare('UPDATE payloads SET bytes = ? WHERE payload_ref = ?').run(content('tampered'), job.payloadRef);
    await expect(storage.readReleasedPayload(job.payloadRef)).rejects.toMatchObject({ code: 'payload_unavailable' });
    const reopened = await reopen(storage, state);
    expect((await recoverConnectorStorage(reopened)).blocked).toEqual(['payload_damaged']);
  });
});

describe('transaction guards', () => {
  it('commits nothing when the callback swallows a failed operation', async () => {
    const { storage } = await fresh();
    await expect(storage.ledger.transaction(tx => {
      tx.putBinding(binding(0));
      try {
        tx.putBinding({ ...binding(1), generation: -1 });
      } catch {
        // A consumer that catches and carries on must not commit a partial outcome.
      }
      return 'done';
    })).rejects.toMatchObject({ code: 'transaction_aborted' });
    expect(await storage.ledger.transaction(tx => tx.readBinding(bindingId))).toBeNull();
  });

  it('refuses port calls and commit once SQLite has rolled the transaction back', async () => {
    const { storage } = await fresh();
    let afterRollback: unknown;
    await expect(storage.ledger.transaction(tx => {
      tx.putBinding(binding(0));
      rawDb(storage).exec('ROLLBACK');
      try {
        tx.readBinding(bindingId);
      } catch (error) {
        afterRollback = error;
      }
    })).rejects.toMatchObject({ code: 'transaction_aborted' });
    expect(afterRollback).toMatchObject({ code: 'transaction_aborted' });
    expect(await storage.ledger.transaction(tx => tx.readBinding(bindingId))).toBeNull();
  });

  it('aborts at commit when SQLite rolled back behind a callback that made no port call', async () => {
    const { storage } = await fresh();
    await expect(storage.ledger.transaction(() => {
      rawDb(storage).exec('ROLLBACK');
    })).rejects.toMatchObject({ code: 'transaction_aborted' });
  });
});
