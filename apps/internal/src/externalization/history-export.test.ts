import fs from 'node:fs';
import path from 'node:path';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import {
  type DeviceId, type EventId, type OwnerId, type ParticipantId, type RoomId,
} from '@khala/contracts/messaging/index';
import {
  type ConversionJournalPort, type ConversionState, type HistoryTransferPort, type HistoryTransferProgress,
} from '@khala/contracts/messaging/externalization';
import { createFakeConversionJournal } from '@khala/contracts/messaging/externalization.fake';
import {
  type ImportedHistoryActor, type ImportedHistoryLimits, decodeImportedHistoryLimits,
} from '@khala/contracts/messaging/imported-history';
import { importedContextPage } from '@khala/messaging/channels/imported-history';
import {
  type ImportedHistoryPart, type ImportedHistoryTransport, type ImportedPartLookup, openImportedArchive,
} from '@khala/messaging/channels/history-import';
import { afterEach, describe, expect, it } from 'vitest';
import { createChannelStore, type ChannelStore, type RegisteredParticipant } from '../store/channel-store';
import { openChannelStore, type InternalStoreHandle } from '../store/open';
import {
  type ConversionTarget, type HistoryDrainCeiling, type HistoryExportLogEntry, type SourceWriteGate, MAX_CATCH_UP_ROUNDS,
} from './history-export';
import { createComposedHistoryExport } from '../composition/history-transfer';
import { HISTORY_TRANSFER_LEDGER_FILE, type HistoryTransferLedger, openHistoryTransferLedger } from './transfer-ledger';

const roots: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const ada: RegisteredParticipant = {
  participantId: 'participant-ada' as ParticipantId, ownerId: 'owner-ada' as OwnerId, kind: 'human', displayName: 'Ada',
};
const bot: RegisteredParticipant = {
  participantId: 'participant-bot' as ParticipantId, ownerId: 'owner-ada' as OwnerId, kind: 'agent', displayName: 'Build bot',
};
const adaDevice = 'device-ada' as DeviceId;
const botDevice = 'device-bot' as DeviceId;
const channelId = 'internal-channel' as RoomId;
const destination = 'external-room' as RoomId;
const owner: ImportedHistoryActor = { ownerId: 'owner-ada' as OwnerId, participantId: '@ada:example.org' as ParticipantId };
const botBinding: SessionBinding = {
  v: 1, bindingId: 'binding-bot' as SessionBinding['bindingId'], ownerId: bot.ownerId, agentParticipantId: bot.participantId,
  deviceId: botDevice, harness: 'codex', sessionId: 'session-bot', generation: 1,
};

const limitsOf = (): ImportedHistoryLimits => {
  const decoded = decodeImportedHistoryLimits({
    maxBodyBytes: 256, maxAuthorLabelBytes: 64, maxRecordsPerChunk: 2, maxChunkBytes: 4096, maxChunks: 64,
    maxPageRecords: 3, maxPageBytes: 512,
  });
  if (!decoded.ok) throw new Error('limits');
  return decoded.value;
};
const limits = limitsOf();

function privateDir(prefix: string): string {
  const root = fs.mkdtempSync(path.join('/tmp', prefix));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

/** A fake of the provider seam. Parts are stored apart from any timeline and deduplicated on transaction ID. */
class FakeTransport implements ImportedHistoryTransport {
  readonly stored = new Map<string, Readonly<{ partId: string; roomId: RoomId; part: ImportedHistoryPart }>>();
  readonly puts: string[] = [];
  /** Called before each put; returning a mode decides what the put does. */
  fault: (clientTxnId: string) => 'ok' | 'unavailable' | 'lose_ack' = () => 'ok';
  onPut: (part: ImportedHistoryPart) => void = () => {};

  async putPart(input: Readonly<{ roomId: RoomId; clientTxnId: string; part: ImportedHistoryPart }>) {
    const mode = this.fault(input.clientTxnId);
    if (mode === 'unavailable') return { kind: 'unavailable' } as const;
    this.puts.push(input.clientTxnId);
    this.onPut(input.part);
    const existing = this.stored.get(input.clientTxnId);
    const partId = existing?.partId ?? `part-${this.stored.size + 1}`;
    if (!existing) this.stored.set(input.clientTxnId, { partId, roomId: input.roomId, part: structuredClone(input.part) });
    return mode === 'lose_ack' ? { kind: 'unknown' } as const : { kind: 'done', value: { partId } } as const;
  }

  async findPart(input: Readonly<{ roomId: RoomId; clientTxnId: string }>): Promise<ImportedPartLookup> {
    const found = this.stored.get(input.clientTxnId);
    return found && found.roomId === input.roomId ? { kind: 'found', partId: found.partId } : { kind: 'absent' };
  }

  async readParts(input: Readonly<{ roomId: RoomId; archiveId: string }>) {
    const parts = [...this.stored.values()].filter(entry => entry.roomId === input.roomId && entry.part.archiveId === input.archiveId);
    const manifest = parts.find(entry => entry.part.kind === 'manifest')?.part;
    const chunks = parts.flatMap(entry => entry.part.kind === 'chunk' ? [entry.part] : [])
      .sort((a, b) => a.index - b.index).map(part => part.chunk);
    return { kind: 'done', value: { manifest: manifest?.kind === 'manifest' ? manifest.manifest : null, chunks } } as const;
  }
}

class FakeGate implements SourceWriteGate {
  paused = false;
  resumes = 0;
  async pause() {
    this.paused = true;
    return 'paused' as const;
  }
  async resume() {
    this.paused = false;
    this.resumes += 1;
    return 'resumed' as const;
  }
}

type Harness = Readonly<{
  handle: InternalStoreHandle;
  store: ChannelStore;
  journal: ConversionJournalPort;
  ledger: HistoryTransferLedger;
  ledgerDir: string;
  transport: FakeTransport;
  gate: FakeGate;
  port: HistoryTransferPort;
  logs: HistoryExportLogEntry[];
  clock: { now: number };
  session: { actor: ImportedHistoryActor | null };
  target: { value: ConversionTarget };
  /** Appends one source message unless the gate has paused writes. */
  append: (body?: string) => boolean;
  bodies: () => string[];
  advance: (to: ConversionState) => Promise<void>;
  reopen: () => HistoryTransferPort;
}>;



async function harness(ceiling: HistoryDrainCeiling = { maxDrainChunks: 8, drainDeadlineMs: 60_000 }): Promise<Harness> {
  const root = privateDir('khala-history-export-');
  const handle = openChannelStore({ directory: path.join(root, 'state'), mode: 'create' });
  closers.push(() => handle.close());
  const store = createChannelStore(handle);
  store.registerParticipant(ada);
  store.registerParticipant(bot);
  store.registerDevice({ deviceId: adaDevice, participantId: ada.participantId });
  store.registerDevice({ deviceId: botDevice, participantId: bot.participantId });
  store.registerBinding(botBinding);
  store.createChannel({
    operationId: 'create-internal', channelId, title: 'Internal', creatorOwnerId: ada.ownerId,
    creatorParticipantId: ada.participantId, creatorDeviceId: adaDevice, createdAt: '2026-09-25T10:00:00.000Z',
  });
  store.setMembership({ channelId, participantId: bot.participantId, membership: 'joined' });

  const journal = createFakeConversionJournal();
  await journal.create({ v: 1, conversionId: 'conversion-1', operationId: 'op-convert', historyMode: 'carry_history' });
  let revision = 0;
  let state: ConversionState = 'preparing';
  const advance = async (to: ConversionState) => {
    const result = await journal.advance({
      v: 1, conversionId: 'conversion-1', operationId: `op-advance-${revision}`, expectedRevision: revision, from: state, to,
    });
    if (result.kind !== 'ok') throw new Error(`advance ${state} -> ${to}: ${JSON.stringify(result)}`);
    revision = result.value.revision;
    state = to;
  };
  await advance('external_created');
  await advance('history_copying');

  const ledgerDir = privateDir('khala-history-ledger-');
  const transport = new FakeTransport();
  const gate = new FakeGate();
  const logs: HistoryExportLogEntry[] = [];
  const clock = { now: Date.parse('2026-09-25T12:00:00Z') };
  const session = { actor: owner as ImportedHistoryActor | null };
  const target = { value: { sourceChannelId: channelId, destinationRoomId: destination, owner } as ConversionTarget };
  const open = () => {
    const ledger = openHistoryTransferLedger(ledgerDir);
    closers.push(() => ledger.close());
    return ledger;
  };
  const make = (ledger: HistoryTransferLedger) => createComposedHistoryExport({
    source: handle, journal, ledger, transport, gate,
    session: () => session.actor,
    target: async conversionId => conversionId === 'conversion-1' ? target.value : null,
    limits, ceiling, now: () => clock.now, log: entry => logs.push(entry),
  });
  const ledger = open();
  const bodies: string[] = [];
  let appended = 0;
  const append = (body?: string) => {
    if (gate.paused) return false;
    appended += 1;
    const text = body ?? `message ${appended}: ✓ ünïcödé\nsecond line`;
    const stored = store.send({
      channelId, eventId: `event-${appended}` as EventId, authorParticipantId: appended % 2 ? ada.participantId : bot.participantId,
      authorDeviceId: appended % 2 ? adaDevice : botDevice, clientTxnId: `txn-${appended}`, content: { v: 1, kind: 'text', body: text },
      receivedAt: `2026-09-25T11:${String(Math.floor(appended / 60) % 60).padStart(2, '0')}:${String(appended % 60).padStart(2, '0')}.000Z`,
    });
    if (stored.kind !== 'stored') throw new Error(`send failed: ${JSON.stringify(stored)}`);
    bodies.push(text);
    return true;
  };
  return {
    handle, store, journal, ledger, ledgerDir, transport, gate, port: make(ledger), logs, clock, session, target, append,
    bodies: () => [...bodies], advance, reopen: () => make(open()),
  };
}

const step = (phase: 'copy' | 'catch_up' | 'final_drain', round: number, afterChunk = 0, operationId = 'op-convert') => ({
  v: 1 as const, conversionId: 'conversion-1', operationId, phase, round, afterChunk,
});

function expectOk(result: Awaited<ReturnType<HistoryTransferPort['step']>>): HistoryTransferProgress {
  if (result.kind !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result.value;
}

/** Drives the service's side of the journal through copy, catch-up and the final drain. */
async function transfer(h: Harness, port = h.port): Promise<HistoryTransferProgress> {
  const copied = expectOk(await port.step(step('copy', 0)));
  expect(copied.outcome).toBe('more');
  await h.advance('history_catching_up');
  let outcome: HistoryTransferProgress['outcome'] = 'more';
  for (let round = 1; outcome === 'more'; round += 1) outcome = expectOk(await port.step(step('catch_up', round))).outcome;
  if (outcome === 'drain_required') await h.advance('drain_required');
  const drained = expectOk(await port.step(step('final_drain', 0)));
  expect(drained).toMatchObject({ outcome: 'converged' });
  expect(drained.lastAckChunk).toBe(drained.chunkCount);
  return drained;
}

async function openArchive(h: Harness, manifestDigest: string) {
  const opened = await openImportedArchive(h.transport, { roomId: destination, archiveId: 'history.conversion-1', manifestDigest, limits });
  if (!opened.ok) throw new Error(`archive did not open: ${JSON.stringify(opened)}`);
  return opened.view;
}

describe('checkpointed history transfer', () => {
  it('sends every chunk and the manifest through the encrypted transport and reconciles order, count and digests', async () => {
    const h = await harness();
    for (let i = 0; i < 5; i += 1) h.append();

    h.append('line one\r\nline two\n\ttabbed 🧪 and "quotes" \\ backslash');
    const done = await transfer(h);
    const view = await openArchive(h, done.manifestDigest);
    expect(view.records.map(record => record.body)).toEqual(h.bodies());
    expect(view.records.map(record => record.originalAuthor)).toEqual(
      h.bodies().map((_, i) => (i % 2 === 0 ? { label: 'Ada', kind: 'human' } : { label: 'Build bot', kind: 'agent' })),
    );
    expect(view.importedBy).toEqual(owner);
    // Every archive write went through the transport, to the bound destination only.
    expect([...h.transport.stored.values()].every(entry => entry.roomId === destination)).toBe(true);
    expect(h.transport.stored.size).toBe(done.chunkCount + 1);
    expect(new Set(h.transport.puts).size).toBe(h.transport.puts.length);
    // The drain pauses the source; a converged transfer leaves it paused for the link commit.
    expect(h.gate.paused).toBe(true);
  });

  it('resumes after an interruption at every chunk without duplicating a record', async () => {
    const h = await harness();
    for (let i = 0; i < 7; i += 1) h.append();
    let failures = 0;
    const failed = new Set<string>();
    h.transport.fault = id => {
      if (failed.has(id)) return 'ok';
      failed.add(id);
      failures += 1;
      return 'unavailable';
    };
    let result = await h.port.step(step('copy', 0));
    let attempts = 0;
    while (result.kind !== 'ok') {
      expect(result).toEqual({ kind: 'unavailable', retryable: true });
      // A restart resumes from the persisted acknowledgements, not from memory.
      result = await h.reopen().step(step('copy', 0));
      attempts += 1;
      expect(attempts).toBeLessThan(20);
    }
    expect(failures).toBe(4);
    expect(result.value).toMatchObject({ outcome: 'more', lastAckChunk: 4, chunkCount: 4 });
    h.transport.fault = () => 'ok';
    const done = await transfer(h, h.reopen());
    const view = await openArchive(h, done.manifestDigest);
    expect(view.records.map(record => record.body)).toEqual(h.bodies());
    expect(new Set(h.transport.puts).size).toBe(h.transport.puts.length);
    // An acknowledged chunk is never delivered again, not even as a reconciliation.
    const acked = h.logs.flatMap(entry => entry.event === 'chunk_acknowledged' ? [entry.index] : []);
    expect(acked).toEqual([...new Set(acked)]);
  });

  it('refuses to resume a sealed chunk whose source no longer reproduces its digest', async () => {
    const h = await harness();
    for (let i = 0; i < 7; i += 1) h.append();
    h.transport.fault = id => (id === 'history.conversion-1.chunk.1' ? 'unavailable' : 'ok');
    expect(await h.port.step(step('copy', 0))).toEqual({ kind: 'unavailable', retryable: true });
    // Chunk 1 holds a message by the bot; its label changes before the retry re-reads it.
    h.handle.transaction(db => db.prepare('UPDATE participants SET display_name = ? WHERE participant_id = ?').run('Renamed', bot.participantId));
    h.transport.fault = () => 'ok';
    expect(await h.reopen().step(step('copy', 0))).toEqual({ kind: 'rejected', code: 'source_changed' });
    expect(h.transport.puts).toEqual(['history.conversion-1.chunk.0']);
  });

  it('reconciles messages appended during the copy through catch-up instead of aborting on the changed revision', async () => {
    const h = await harness();
    for (let i = 0; i < 6; i += 1) h.append();
    let during = 0;
    h.transport.onPut = part => {
      if (part.kind === 'chunk' && during < 3) {
        during += 1;
        h.append(`appended during copy ${during}`);
      }
    };
    const copied = expectOk(await h.port.step(step('copy', 0)));
    expect(copied).toMatchObject({ outcome: 'more', chunkCount: 3 });
    await h.advance('history_catching_up');
    // Three appended messages need two chunks: more than one final delta, so the round copies them.
    const first = expectOk(await h.port.step(step('catch_up', 1)));
    expect(first.outcome).toBe('more');
    expect(first.chunkCount).toBe(5);
    const second = expectOk(await h.port.step(step('catch_up', 2)));
    expect(second.outcome).toBe('converged');
    const drained = expectOk(await h.port.step(step('final_drain', 0)));
    const view = await openArchive(h, drained.manifestDigest);
    expect(view.records.map(record => record.body)).toEqual(h.bodies());
    expect(view.records.filter(record => record.body.startsWith('appended during copy'))).toHaveLength(3);
  });

  it('returns drain_required after three catch-up rounds when the producer outpaces the transfer', async () => {
    const h = await harness();
    for (let i = 0; i < 2; i += 1) h.append();
    h.transport.onPut = () => { for (let i = 0; i < 3; i += 1) h.append(); };
    expectOk(await h.port.step(step('copy', 0)));
    await h.advance('history_catching_up');
    const outcomes: string[] = [];
    for (let round = 1; round <= MAX_CATCH_UP_ROUNDS; round += 1) outcomes.push(expectOk(await h.port.step(step('catch_up', round))).outcome);
    expect(outcomes).toEqual(['more', 'more', 'drain_required']);
    expect(await h.port.step(step('catch_up', 4))).toEqual({ kind: 'rejected', code: 'wrong_state' });
    // A drain the human has not confirmed does not run.
    expect(await h.port.step(step('final_drain', 0))).toEqual({ kind: 'rejected', code: 'wrong_state' });
    expect(h.gate.paused).toBe(false);
  });

  it('completes a confirmed paused drain, then blocks finitely with the source resumed when the ceiling is exceeded', async () => {
    const run = async (ceiling: HistoryDrainCeiling) => {
      const h = await harness(ceiling);
      h.append();
      h.transport.onPut = () => { for (let i = 0; i < 3; i += 1) h.append(); };
      expectOk(await h.port.step(step('copy', 0)));
      await h.advance('history_catching_up');
      for (let round = 1; round <= MAX_CATCH_UP_ROUNDS; round += 1) expectOk(await h.port.step(step('catch_up', round)));
      await h.advance('drain_required');
      return h;
    };

    const completed = await run({ maxDrainChunks: 64, drainDeadlineMs: 60_000 });
    const drained = expectOk(await completed.port.step(step('final_drain', 0)));
    expect(drained.outcome).toBe('converged');
    expect(completed.gate.paused).toBe(true);
    const view = await openArchive(completed, drained.manifestDigest);
    expect(view.records.map(record => record.body)).toEqual(completed.bodies());

    const tooLarge = await run({ maxDrainChunks: 1, drainDeadlineMs: 60_000 });
    expect(await tooLarge.port.step(step('final_drain', 0))).toEqual({ kind: 'rejected', code: 'ceiling_exceeded' });
    expect(tooLarge.gate.paused).toBe(false);
    // The blocked result is terminal: a retry neither pauses the source nor sends anything.
    const puts = tooLarge.transport.puts.length;
    expect(await tooLarge.port.step(step('final_drain', 0))).toEqual({ kind: 'rejected', code: 'ceiling_exceeded' });
    expect(tooLarge.gate.paused).toBe(false);
    expect(tooLarge.transport.puts).toHaveLength(puts);
    expect(tooLarge.logs.map(entry => entry.event)).toContain('drain_blocked');

    const tooSlow = await run({ maxDrainChunks: 64, drainDeadlineMs: 1_000 });
    tooSlow.transport.onPut = () => { tooSlow.clock.now += 600; };
    expect(await tooSlow.port.step(step('final_drain', 0))).toEqual({ kind: 'rejected', code: 'ceiling_exceeded' });
    expect(tooSlow.gate.paused).toBe(false);
  });

  it('keeps the drain deadline across retries so a stalled drain still ends', async () => {
    const h = await harness({ maxDrainChunks: 64, drainDeadlineMs: 1_000 });
    h.append();
    expectOk(await h.port.step(step('copy', 0)));
    await h.advance('history_catching_up');
    for (let i = 0; i < 4; i += 1) h.append();
    expect(expectOk(await h.port.step(step('catch_up', 1))).outcome).toBe('more');
    expect(expectOk(await h.port.step(step('catch_up', 2))).outcome).toBe('converged');
    h.transport.fault = () => 'unavailable';
    expect((await h.port.step(step('final_drain', 0))).kind).toBe('unavailable');
    h.clock.now += 5_000;
    h.transport.fault = () => 'ok';
    expect(await h.reopen().step(step('final_drain', 0))).toEqual({ kind: 'rejected', code: 'ceiling_exceeded' });
    expect(h.gate.paused).toBe(false);
  });

  it('seals messages written while a failed drain had handed the source back', async () => {
    const h = await harness();
    h.append();
    expectOk(await h.port.step(step('copy', 0)));
    await h.advance('history_catching_up');
    h.append();
    expect(expectOk(await h.port.step(step('catch_up', 1))).outcome).toBe('converged');
    h.transport.fault = () => 'unavailable';
    expect((await h.port.step(step('final_drain', 0))).kind).toBe('unavailable');
    // The caller gives up on this attempt and resumes the internal channel; people keep talking.
    await h.gate.resume();
    h.append();
    h.append();
    h.transport.fault = () => 'ok';
    const done = expectOk(await h.reopen().step(step('final_drain', 0)));
    const view = await openArchive(h, done.manifestDigest);
    expect(view.records.map(record => record.body)).toEqual(h.bodies());
  });

  it('refuses to close an archive the source outgrew after its manifest was fixed, and resumes the source', async () => {
    const h = await harness();
    h.append();
    expectOk(await h.port.step(step('copy', 0)));
    await h.advance('history_catching_up');
    expect(expectOk(await h.port.step(step('catch_up', 1))).outcome).toBe('converged');
    h.transport.fault = id => (id.endsWith('.manifest') ? 'unavailable' : 'ok');
    expect((await h.port.step(step('final_drain', 0))).kind).toBe('unavailable');
    await h.gate.resume();
    h.append();
    h.transport.fault = () => 'ok';
    expect(await h.reopen().step(step('final_drain', 0))).toEqual({ kind: 'rejected', code: 'source_changed' });
    expect(h.gate.paused).toBe(false);
    expect(h.transport.puts.filter(id => id.endsWith('.manifest'))).toHaveLength(0);
  });

  it('refuses a drain ceiling that is not finite', async () => {
    await expect(harness({ maxDrainChunks: Number.POSITIVE_INFINITY, drainDeadlineMs: 1_000 })).rejects.toThrow(RangeError);
    await expect(harness({ maxDrainChunks: 8, drainDeadlineMs: Number.NaN })).rejects.toThrow(RangeError);
  });

  it('reconciles a lost final acknowledgement from the destination without sending the manifest twice', async () => {
    const h = await harness();
    for (let i = 0; i < 3; i += 1) h.append();
    expectOk(await h.port.step(step('copy', 0)));
    await h.advance('history_catching_up');
    expect(expectOk(await h.port.step(step('catch_up', 1))).outcome).toBe('converged');
    h.transport.fault = id => (id.endsWith('.manifest') ? 'lose_ack' : 'ok');
    const lost = await h.port.step(step('final_drain', 0));
    expect(lost).toEqual({ kind: 'outcome_unknown', operationId: 'history.conversion-1.manifest' });
    h.transport.fault = () => 'ok';
    const done = expectOk(await h.reopen().step(step('final_drain', 0)));
    expect(done.outcome).toBe('converged');
    expect(h.transport.puts.filter(id => id.endsWith('.manifest'))).toHaveLength(1);
    expect(h.logs).toContainEqual({ event: 'manifest_acknowledged', conversionId: 'conversion-1', reconciled: true });
    // A replay of the finished step reports the same result and writes nothing.
    const puts = h.transport.puts.length;
    expect(expectOk(await h.port.step(step('final_drain', 0)))).toEqual(done);
    expect(h.transport.puts).toHaveLength(puts);
    await openArchive(h, done.manifestDigest);
  });

  it('refuses writes for another principal, operation or destination channel', async () => {
    const h = await harness();
    h.append();
    h.session.actor = { ownerId: 'owner-mallory' as OwnerId, participantId: '@mallory:example.org' as ParticipantId };
    expect(await h.port.step(step('copy', 0))).toEqual({ kind: 'rejected', code: 'forbidden' });
    h.session.actor = null;
    expect(await h.port.step(step('copy', 0))).toEqual({ kind: 'rejected', code: 'forbidden' });
    h.session.actor = owner;
    expect(await h.port.step(step('copy', 0, 0, 'op-other'))).toEqual({ kind: 'rejected', code: 'operation_mismatch' });
    expect(h.transport.puts).toEqual([]);

    expectOk(await h.port.step(step('copy', 0)));
    await h.advance('history_catching_up');
    h.target.value = { ...h.target.value, destinationRoomId: 'other-room' as RoomId };
    expect(await h.port.step(step('catch_up', 1))).toEqual({ kind: 'rejected', code: 'forbidden' });
    h.target.value = { ...h.target.value, destinationRoomId: destination, owner: { ...owner, participantId: '@other:example.org' as ParticipantId } };
    h.session.actor = h.target.value.owner;
    expect(await h.port.step(step('catch_up', 1))).toEqual({ kind: 'rejected', code: 'forbidden' });
    expect([...h.transport.stored.values()].every(entry => entry.roomId === destination)).toBe(true);
    // A caller cannot claim acknowledgements the ledger does not hold.
    h.target.value = { ...h.target.value, owner };
    h.session.actor = owner;
    expect(await h.port.step(step('catch_up', 1, 99))).toEqual({ kind: 'rejected', code: 'operation_mismatch' });
  });

  it('keeps bodies out of the persisted ledger and operator logs, inside a 0700/0600 boundary', async () => {
    const h = await harness();
    const secrets = ['secret body alpha', 'secret body beta', 'secret body gamma'];
    for (const secret of secrets) h.append(secret);
    await transfer(h);
    const file = path.join(h.ledgerDir, HISTORY_TRANSFER_LEDGER_FILE);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(h.ledgerDir).mode & 0o777).toBe(0o700);
    const bytes = fs.readdirSync(h.ledgerDir).map(name => fs.readFileSync(path.join(h.ledgerDir, name)).toString('latin1')).join('');
    const logText = JSON.stringify(h.logs);
    for (const needle of [...secrets, 'Ada', 'Build bot']) {
      expect(bytes).not.toContain(needle);
      expect(logText).not.toContain(needle);
    }
    expect(h.logs.length).toBeGreaterThan(0);
    fs.chmodSync(h.ledgerDir, 0o755);
    expect(() => openHistoryTransferLedger(h.ledgerDir)).toThrow('unsafe_path');
  });

  it('adds no imported event to delivery or receipt projections, and agents page context without enqueueing', async () => {
    const h = await harness();
    for (let i = 0; i < 5; i += 1) h.append();
    const before = h.store.readSubscription({ channelId, binding: botBinding, cursor: null, limit: 50 });
    if (before.kind !== 'page') throw new Error('expected subscription page');
    const done = await transfer(h);
    const after = h.store.readSubscription({ channelId, binding: botBinding, cursor: before.nextCursor, limit: 50 });
    expect(after).toMatchObject({ kind: 'page', events: [] });
    const counts = h.handle.read(db => ({
      events: Number((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n),
      receipts: Number((db.prepare('SELECT COUNT(*) AS n FROM receipt_facts').get() as { n: number }).n),
    }));
    expect(counts).toEqual({ events: 5, receipts: 0 });

    const view = await openArchive(h, done.manifestDigest);
    const puts = h.transport.puts.length;
    const first = importedContextPage(view, { cursor: null, limit: 10 }, limits);
    if (!first.ok) throw new Error('page');
    expect(first.page.records).toHaveLength(3);
    const second = importedContextPage(view, { cursor: first.page.nextCursor, limit: 10 }, limits);
    expect(second).toMatchObject({ ok: true, page: { nextCursor: null } });
    expect(h.transport.puts).toHaveLength(puts);
    expect(h.store.readSubscription({ channelId, binding: botBinding, cursor: before.nextCursor, limit: 50 }))
      .toMatchObject({ kind: 'page', events: [] });
  });

  it('refuses a start-fresh conversion and steps out of journal order', async () => {
    const h = await harness();
    h.append();
    expect(await h.port.step(step('catch_up', 1))).toEqual({ kind: 'rejected', code: 'wrong_state' });
    expect(await h.port.step(step('final_drain', 0))).toEqual({ kind: 'rejected', code: 'wrong_state' });
    expect(await h.port.step({ ...step('copy', 0), round: -1 })).toEqual({ kind: 'rejected', code: 'invalid_request' });
    await h.journal.create({ v: 1, conversionId: 'conversion-2', operationId: 'op-fresh', historyMode: 'start_fresh' });
    expect(await h.port.step({ ...step('copy', 0, 0, 'op-fresh'), conversionId: 'conversion-2' }))
      .toEqual({ kind: 'rejected', code: 'wrong_state' });
    expect(await h.port.step({ ...step('copy', 0), conversionId: 'missing' })).toEqual({ kind: 'rejected', code: 'not_found' });
  });
});
