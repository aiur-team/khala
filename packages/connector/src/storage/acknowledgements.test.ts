// Agent batch-token acknowledgements against a real on-disk ledger. Reopening between
// steps checks what was durably committed rather than what a handle remembers.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { BindingId, ReleaseId, SessionBinding } from '@khala/contracts/delivery/index';
import {
  acceptBatchAcknowledgement, agentAcknowledgementReceiptId, createAcknowledgementRecorder,
  type AcknowledgementRecorderOptions, type AgentPrincipal,
} from './acknowledgements';
import {
  approval, binding, bindingId, commandRecord, content, eventRef, limits, pendingInput, release, scratchDirectory,
} from './fixtures/fakes';
import { LEDGER_FILE } from './leases';
import { type ConnectorStorage, openConnectorStorage } from './open';
import { SCHEMA_VERSION } from './schema';

const opened: ConnectorStorage[] = [];
const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map(storage => storage.close()));
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const PRINCIPAL: AgentPrincipal = { bindingId, generation: 0 };
const OTHER: SessionBinding = { ...binding(0), bindingId: 'binding_c' as BindingId, sessionId: 'session_c' };
const CLOCK: AcknowledgementRecorderOptions = { now: () => new Date('2026-09-25T12:00:00.123Z') };

async function fresh() {
  const { parent, state } = scratchDirectory();
  scratch.push(parent);
  const storage = await openConnectorStorage({ directory: state, mode: 'create', limits });
  opened.push(storage);
  return { storage, state };
}

async function reopen(storage: ConnectorStorage, state: string) {
  await storage.close();
  const next = await openConnectorStorage({ directory: state, mode: 'existing', limits });
  opened.push(next);
  return next;
}

/** Commits one released job per release ID, all for the current `binding_b` generation. */
async function seedReleases(storage: ConnectorStorage, releaseIds: readonly string[], generation = 0) {
  await storage.ledger.transaction(tx => tx.putBinding(binding(generation)));
  for (const [index, releaseId] of releaseIds.entries()) {
    const body = `body ${releaseId}`;
    await storage.persistPending(pendingInput(`event_${index}_${generation}`, body, generation));
    const command = approval(`command_${releaseId}`, [eventRef(`event_${index}_${generation}`, body)], generation);
    const payload = content(`payload ${releaseId}`);
    const job = release(command, binding(generation), payload, releaseId);
    const expectedLedgerRevision = await storage.ledger.transaction(tx => tx.ledgerRevision());
    const result = await storage.ledger.transaction(tx => tx.putRelease({
      command: commandRecord(command, releaseId), job, payload, expectedLedgerRevision,
    }));
    if (result.kind !== 'committed') throw new Error(`seed release: ${result.kind}`);
  }
}

async function revokeBinding(storage: ConnectorStorage) {
  await storage.ledger.transaction(tx => tx.putRevocation({
    targetKind: 'binding', targetId: bindingId, generation: 0, operationId: 'op_revoke', revokedAt: '2026-09-25T12:01:00Z',
  }));
}

async function agentReceipts(storage: ConnectorStorage, releaseIds: readonly string[]) {
  return storage.ledger.transaction(tx => releaseIds.flatMap(releaseId => tx.readReceipts(releaseId as ReleaseId))
    .filter(stored => stored.receipt.kind === 'agent_acknowledged'));
}

const ids = (...values: string[]) => values as ReleaseId[];

describe('batch acknowledgement recording', () => {
  it('records one content-free receipt and outbox entry per release, sharing one evidence reference', async () => {
    const { storage } = await fresh();
    await seedReleases(storage, ['release_1', 'release_2', 'release_3']);
    const recorder = createAcknowledgementRecorder(storage, { ...CLOCK, newEvidenceRef: () => 'ack_evidence_1' });

    const result = await recorder.recordBatchAcknowledgement({ principal: PRINCIPAL, releaseIds: ids('release_1', 'release_2', 'release_3') });

    expect(result.kind).toBe('recorded');
    if (result.kind !== 'recorded') return;
    expect(result.evidenceRef).toBe('ack_evidence_1');
    expect(result.receipts).toEqual(['release_1', 'release_2', 'release_3'].map(releaseId => ({
      v: 2,
      receiptId: agentAcknowledgementReceiptId(PRINCIPAL, releaseId as ReleaseId),
      releaseId,
      bindingId,
      generation: 0,
      kind: 'agent_acknowledged',
      observedAt: '2026-09-25T12:00:00Z',
      source: 'agent',
      evidenceRef: 'ack_evidence_1',
      errorCode: null,
    })));
    const stored = await agentReceipts(storage, ['release_1', 'release_2', 'release_3']);
    expect(stored.map(entry => entry.correlation)).toEqual(['correlated', 'correlated', 'correlated']);
    const outbox = await recorder.readReceiptOutbox();
    expect(outbox.map(entry => entry.receipt)).toEqual(result.receipts);
    expect(new Set(outbox.map(entry => entry.evidenceRef))).toEqual(new Set(['ack_evidence_1']));
    // Each entry names its release's channel events by identity only: no digest, no content.
    expect(outbox.map(entry => entry.events)).toEqual(['event_0_0', 'event_1_0', 'event_2_0']
      .map(eventId => [{ roomId: eventRef(eventId, '').roomId, eventId }]));
    for (const entry of outbox) {
      expect(JSON.stringify(entry)).not.toContain('sha256:');
      expect(JSON.stringify(entry)).not.toContain('payload release');
      expect(JSON.stringify(entry)).not.toContain('body release');
    }
  });

  it('uses a fresh evidence reference per acknowledgement so separate batches never group', async () => {
    const { storage } = await fresh();
    await seedReleases(storage, ['release_1', 'release_2']);
    const recorder = createAcknowledgementRecorder(storage);
    const first = await recorder.recordBatchAcknowledgement({ principal: PRINCIPAL, releaseIds: ids('release_1') });
    const second = await recorder.recordBatchAcknowledgement({ principal: PRINCIPAL, releaseIds: ids('release_2') });
    expect(first.kind === 'recorded' && second.kind === 'recorded').toBe(true);
    if (first.kind !== 'recorded' || second.kind !== 'recorded') return;
    expect(first.evidenceRef).not.toBe(second.evidenceRef);
  });

  it('returns the original immutable receipts byte for byte after restart and adds no outbox entry', async () => {
    const { storage, state } = await fresh();
    await seedReleases(storage, ['release_1', 'release_2']);
    const first = await createAcknowledgementRecorder(storage, CLOCK)
      .recordBatchAcknowledgement({ principal: PRINCIPAL, releaseIds: ids('release_1', 'release_2') });
    if (first.kind !== 'recorded') throw new Error(first.kind);

    const reopened = await reopen(storage, state);
    const later = createAcknowledgementRecorder(reopened, {
      now: () => new Date('2030-01-01T00:00:00Z'), newEvidenceRef: () => 'ack_regenerated',
    });
    const replay = await later.recordBatchAcknowledgement({ principal: PRINCIPAL, releaseIds: ids('release_1', 'release_2') });

    expect(replay).toEqual({ kind: 'duplicate', evidenceRef: first.evidenceRef, receipts: first.receipts });
    expect(JSON.stringify(replay.kind === 'duplicate' ? replay.receipts : null)).toBe(JSON.stringify(first.receipts));
    expect(await later.readReceiptOutbox()).toHaveLength(2);
  });

  it('keeps the outbox durable across restart and pages it by ledger revision', async () => {
    const { storage, state } = await fresh();
    await seedReleases(storage, ['release_1', 'release_2']);
    const recorder = createAcknowledgementRecorder(storage);
    await recorder.recordBatchAcknowledgement({ principal: PRINCIPAL, releaseIds: ids('release_1') });
    await recorder.recordBatchAcknowledgement({ principal: PRINCIPAL, releaseIds: ids('release_2') });

    const reopened = createAcknowledgementRecorder(await reopen(storage, state));
    const all = await reopened.readReceiptOutbox();
    expect(all.map(entry => entry.receipt.releaseId)).toEqual(['release_1', 'release_2']);
    const after = await reopened.readReceiptOutbox({ afterRevision: all[0]!.ledgerRevision });
    expect(after.map(entry => entry.receipt.releaseId)).toEqual(['release_2']);
    expect(await reopened.readReceiptOutbox({ limit: 1 })).toHaveLength(1);
    await expect(reopened.readReceiptOutbox({ limit: 101 })).rejects.toMatchObject({ code: 'limit_exceeded' });
  });

  it.each([
    ['an unknown binding', { bindingId: 'binding_unknown' as BindingId, generation: 0 }],
    ['a future generation', { bindingId, generation: 1 }],
  ])('refuses %s with no receipt', async (_label, principal) => {
    const { storage } = await fresh();
    await seedReleases(storage, ['release_1']);
    const recorder = createAcknowledgementRecorder(storage);
    expect(await recorder.recordBatchAcknowledgement({ principal, releaseIds: ids('release_1') }))
      .toEqual({ kind: 'refused', code: 'binding_not_held' });
    expect(await agentReceipts(storage, ['release_1'])).toEqual([]);
    expect(await recorder.readReceiptOutbox()).toEqual([]);
  });

  it('refuses a superseded generation acknowledging its own earlier batch', async () => {
    const { storage } = await fresh();
    await seedReleases(storage, ['release_1']);
    await storage.ledger.transaction(tx => tx.putBinding(binding(1)));
    const recorder = createAcknowledgementRecorder(storage);
    expect(await recorder.recordBatchAcknowledgement({ principal: PRINCIPAL, releaseIds: ids('release_1') }))
      .toEqual({ kind: 'refused', code: 'binding_not_held' });
    // The new generation cannot claim the old generation's release either.
    expect(await recorder.recordBatchAcknowledgement({ principal: { bindingId, generation: 1 }, releaseIds: ids('release_1') }))
      .toEqual({ kind: 'refused', code: 'invalid_input' });
    expect(await agentReceipts(storage, ['release_1'])).toEqual([]);
  });

  it('refuses agent B acknowledging a release made available to agent A', async () => {
    const { storage } = await fresh();
    await seedReleases(storage, ['release_1']);
    await storage.ledger.transaction(tx => tx.putBinding(OTHER));
    const recorder = createAcknowledgementRecorder(storage);
    expect(await recorder.recordBatchAcknowledgement({
      principal: { bindingId: OTHER.bindingId, generation: 0 }, releaseIds: ids('release_1'),
    })).toEqual({ kind: 'refused', code: 'invalid_input' });
    expect(await agentReceipts(storage, ['release_1'])).toEqual([]);
  });

  it('refuses a release that was never made available, and records none of a mixed batch', async () => {
    const { storage } = await fresh();
    await seedReleases(storage, ['release_1']);
    const recorder = createAcknowledgementRecorder(storage);
    expect(await recorder.recordBatchAcknowledgement({ principal: PRINCIPAL, releaseIds: ids('release_1', 'release_invented') }))
      .toEqual({ kind: 'refused', code: 'invalid_input' });
    expect(await agentReceipts(storage, ['release_1', 'release_invented'])).toEqual([]);
  });

  it('refuses a partial overlap with an earlier acknowledgement instead of mixing evidence references', async () => {
    const { storage } = await fresh();
    await seedReleases(storage, ['release_1', 'release_2']);
    const recorder = createAcknowledgementRecorder(storage);
    await recorder.recordBatchAcknowledgement({ principal: PRINCIPAL, releaseIds: ids('release_1') });
    expect(await recorder.recordBatchAcknowledgement({ principal: PRINCIPAL, releaseIds: ids('release_1', 'release_2') }))
      .toEqual({ kind: 'refused', code: 'invalid_input' });
    expect(await agentReceipts(storage, ['release_2'])).toEqual([]);
  });

  it.each([
    ['no releases', []],
    ['a repeated release', ['release_1', 'release_1']],
    ['too many releases', Array.from({ length: 65 }, (_, index) => `release_${index}`)],
  ])('rejects %s as invalid input', async (_label, releaseIds) => {
    const { storage } = await fresh();
    await seedReleases(storage, ['release_1']);
    await expect(createAcknowledgementRecorder(storage)
      .recordBatchAcknowledgement({ principal: PRINCIPAL, releaseIds: releaseIds as ReleaseId[] }))
      .rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('revocation fence', () => {
  it('prevents the fact when revocation serializes first', async () => {
    const { storage } = await fresh();
    await seedReleases(storage, ['release_1']);
    await revokeBinding(storage);
    expect(await createAcknowledgementRecorder(storage)
      .recordBatchAcknowledgement({ principal: PRINCIPAL, releaseIds: ids('release_1') }))
      .toEqual({ kind: 'refused', code: 'binding_not_held' });
    expect(await agentReceipts(storage, ['release_1'])).toEqual([]);
  });

  it('keeps a truthful receipt when revocation serializes after it, and refuses replay as an oracle', async () => {
    const { storage, state } = await fresh();
    await seedReleases(storage, ['release_1']);
    const first = await createAcknowledgementRecorder(storage)
      .recordBatchAcknowledgement({ principal: PRINCIPAL, releaseIds: ids('release_1') });
    expect(first.kind).toBe('recorded');
    await revokeBinding(storage);

    const reopened = await reopen(storage, state);
    const recorder = createAcknowledgementRecorder(reopened);
    // Authorization runs before the idempotency lookup: a revoked caller learns nothing.
    expect(await recorder.recordBatchAcknowledgement({ principal: PRINCIPAL, releaseIds: ids('release_1') }))
      .toEqual({ kind: 'refused', code: 'binding_not_held' });
    expect(await agentReceipts(reopened, ['release_1'])).toHaveLength(1);
    expect(await recorder.readReceiptOutbox()).toHaveLength(1);
  });

  it('serializes a concurrent revocation and acknowledgement in either order', async () => {
    for (const order of ['revoke-first', 'ack-first'] as const) {
      const { storage } = await fresh();
      await seedReleases(storage, ['release_1']);
      const recorder = createAcknowledgementRecorder(storage);
      const ack = () => recorder.recordBatchAcknowledgement({ principal: PRINCIPAL, releaseIds: ids('release_1') });
      const [a, b] = order === 'revoke-first'
        ? await Promise.all([revokeBinding(storage), ack()])
        : await Promise.all([ack(), revokeBinding(storage)]);
      const result = order === 'revoke-first' ? b : a;
      const receipts = await agentReceipts(storage, ['release_1']);
      if (order === 'revoke-first') {
        expect(result).toEqual({ kind: 'refused', code: 'binding_not_held' });
        expect(receipts).toEqual([]);
      } else {
        expect(result).toMatchObject({ kind: 'recorded' });
        expect(receipts).toHaveLength(1);
      }
    }
  });
});

describe('authenticated call boundary', () => {
  it('refuses an unauthenticated caller and a forged binding claim before storage', async () => {
    const { storage } = await fresh();
    await seedReleases(storage, ['release_1']);
    await storage.ledger.transaction(tx => tx.putBinding(OTHER));
    const recorder = createAcknowledgementRecorder(storage);
    const claim = { bindingId, generation: 0, releaseIds: ['release_1'] };

    expect(await acceptBatchAcknowledgement(recorder, null, claim)).toEqual({ kind: 'refused', code: 'binding_not_held' });
    expect(await acceptBatchAcknowledgement(recorder, { bindingId: OTHER.bindingId, generation: 0 }, claim))
      .toEqual({ kind: 'refused', code: 'binding_not_held' });
    expect(await acceptBatchAcknowledgement(recorder, PRINCIPAL, { ...claim, generation: 1 }))
      .toEqual({ kind: 'refused', code: 'binding_not_held' });
    expect(await acceptBatchAcknowledgement(recorder, PRINCIPAL, { ...claim, releaseIds: [] }))
      .toEqual({ kind: 'refused', code: 'invalid_input' });
    expect(await agentReceipts(storage, ['release_1'])).toEqual([]);

    expect(await acceptBatchAcknowledgement(recorder, PRINCIPAL, claim)).toMatchObject({ kind: 'recorded' });
  });
});

describe('schema', () => {
  it('adds the receipt outbox to a version 3 ledger without touching stored receipts', async () => {
    const { storage, state } = await fresh();
    await seedReleases(storage, ['release_1']);
    await storage.close();
    const db = new DatabaseSync(path.join(state, LEDGER_FILE));
    db.exec('DROP TABLE channel_access_activations; DROP TABLE receipt_outbox; PRAGMA user_version = 3;');
    db.close();

    const migrated = await openConnectorStorage({ directory: state, mode: 'existing', limits });
    opened.push(migrated);
    const recorder = createAcknowledgementRecorder(migrated);
    expect(await recorder.readReceiptOutbox()).toEqual([]);
    expect(await recorder.recordBatchAcknowledgement({ principal: PRINCIPAL, releaseIds: ids('release_1') }))
      .toMatchObject({ kind: 'recorded' });
    await migrated.close();
    const raw = new DatabaseSync(path.join(state, LEDGER_FILE));
    expect(raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION });
    raw.close();
  });
});
