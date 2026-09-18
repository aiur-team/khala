// Ledger invariants against a real on-disk store. Reopening between steps checks what
// was durably committed rather than what an in-memory handle remembers.

import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventRef, ReleaseId } from '@khala/contracts/delivery/index';
import {
  approval, binding, bindingId, commandRecord, content, eventRef, limits, ownerId, pendingInput, receipt, release,
  scratchDirectory,
} from './fakes';
import type { ConnectorStorage } from './open';
import { openConnectorStorage } from './open';
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

async function seedBinding(storage: ConnectorStorage, generation = 0) {
  return storage.ledger.transaction(tx => tx.putBinding(binding(generation)));
}

async function snapshot(storage: ConnectorStorage, selection: readonly EventRef[]) {
  return storage.ledger.transaction(tx => tx.readApprovalSnapshot({ bindingId, selection }));
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
    expect(await storage.commitCursor({ streamId: 's', expectedRevision: 0, opaqueCursor: 'c1' }))
      .toEqual({ kind: 'committed', revision: 1 });

    expect(await storage.persistPending(pendingInput('event_7', 'rewritten text')))
      .toEqual({ kind: 'conflict', code: 'event_digest_mismatch' });
    expect(await storage.commitCursor({ streamId: 's', expectedRevision: 1, opaqueCursor: 'c2' }))
      .toEqual({ kind: 'blocked', code: 'quarantine_unresolved' });

    const reopened = await reopen(storage, state);
    const snap = await snapshot(reopened, [eventRef('event_7', 'approved text')]);
    expect(snap?.pending[0]?.content).toEqual(content('approved text'));
    expect(await reopened.readCursor('s')).toEqual({ revision: 1, opaqueCursor: 'c1' });
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
    expect(await reopened.commitCursor({ streamId: 's', expectedRevision: 0, opaqueCursor: 'c1' }))
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
    expect(await reopened.readCursor('s')).toBeNull();
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
    expect(await storage.ledger.transaction(tx => tx.appendReceipt({ receipt: written }))).toEqual({ kind: 'recorded' });
    expect(await storage.ledger.transaction(tx => tx.appendReceipt({ receipt: written }))).toEqual({ kind: 'duplicate' });
    expect(await storage.ledger.transaction(tx => tx.appendReceipt({ receipt: { ...written, observedAt: '2026-09-18T11:00:00Z' } })))
      .toEqual({ kind: 'conflict', code: 'receipt_conflict' });
    expect(await storage.ledger.transaction(tx => tx.appendReceipt({ receipt: receipt('release_unknown', 'completed', 0, 'receipt_orphan') })))
      .toEqual({ kind: 'conflict', code: 'unknown_release' });
    expect(await storage.ledger.transaction(tx => tx.appendReceipt({ receipt: receipt(job.releaseId, 'completed', 3, 'receipt_wrong_gen') })))
      .toEqual({ kind: 'conflict', code: 'correlation_mismatch' });

    let report = await recoverConnectorStorage(storage);
    expect(report.unresolvedReleases).toEqual([job.releaseId]);
    expect(report.uncorrelatedReceipts).toBe(2);

    await storage.ledger.transaction(tx => tx.appendReceipt({ receipt: receipt(job.releaseId, 'completed') }));
    report = await recoverConnectorStorage(storage);
    expect(report.unresolvedReleases).toEqual([]);
    expect(await storage.ledger.transaction(tx => tx.readReceipts(job.releaseId as ReleaseId).map(r => r.kind)))
      .toEqual(['transport_written', 'completed', 'completed']);
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
