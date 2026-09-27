// The receipt projection across its three durability domains: the connector ledger
// (authoritative receipts and outbox), the owner-local channel store (read model and
// checkpoint) and the NDJSON agent log. Every test uses real files, and "crash" means
// closing both stores and reopening them from disk.

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ApprovalCommand, type CausalRootId, type CommandId, type DeviceId, type EventId, type EventRef,
  type OwnerId, type ParticipantId, type ReleaseId, type RoomId, type SessionBinding,
  decodeDeliveryLimits, decodeSessionBinding, releaseFromApproval,
} from '@khala/contracts/delivery/index';
import { encodeMessageContent } from '@khala/contracts/messaging/events';
import {
  type ReceiptObservationLog, type ReceiptReadModel, RECEIPT_OBSERVATION_EVENT, createReceiptProjector,
} from '@khala/connector/receipts/projection';
import {
  type AcknowledgementRecorder, type AgentPrincipal, createAcknowledgementRecorder,
} from '@khala/connector/storage/acknowledgements';
import { type ConnectorStorage, openConnectorStorage } from '@khala/connector/storage/open';
import { newPayloadRef, sha256Digest } from '@khala/connector/storage/payloads';
import { createChannelStore } from '../store/channel-store';
import { type InternalStoreHandle, openChannelStore } from '../store/open';
import { createReceiptReadModel } from '../store/receipts';
import { createInternalReceiptProjector, createNdjsonReceiptLog } from './receipt-projection';

const decodedLimits = decodeDeliveryLimits({ maxSelectionEvents: 20, maxPayloadBytes: 64 * 1024 });
if (!decodedLimits.ok) throw new Error('limits fixture');
const limits = decodedLimits.value;

const CHANNEL = 'channel_1' as RoomId;
const HUMAN = { participantId: 'participant_human' as ParticipantId, deviceId: 'device_human' as DeviceId };
const AGENT = { participantId: 'participant_agent' as ParticipantId, deviceId: 'device_agent' as DeviceId };
const OWNER = 'owner_a' as OwnerId;
const BODY_CANARY = 'CANARY-MESSAGE-BODY';
const PAYLOAD_CANARY = 'CANARY-RELEASE-PAYLOAD';
/** Stands in for the recipient inbox's opaque batch token, which the projection never sees. */
const TOKEN_CANARY = 'CANARY-BATCH-TOKEN';

const decodedBinding = decodeSessionBinding({
  v: 1, bindingId: 'binding_a', ownerId: OWNER, agentParticipantId: AGENT.participantId, deviceId: AGENT.deviceId,
  harness: 'codex', sessionId: 'session_a', generation: 0,
});
if (!decodedBinding.ok) throw new Error('binding fixture');
const BINDING: SessionBinding = decodedBinding.value;
const PRINCIPAL: AgentPrincipal = { bindingId: BINDING.bindingId, generation: BINDING.generation };

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

type World = {
  root: string;
  logFile: string;
  ledger: ConnectorStorage;
  recorder: AcknowledgementRecorder;
  store: InternalStoreHandle;
  /** Closes both stores as a crash would and reopens them from disk. */
  restart(): Promise<void>;
};

async function world(): Promise<World> {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'khala-receipt-projection-'));
  fs.chmodSync(root, 0o700);
  const ledgerState = path.join(root, 'ledger');
  const channelState = path.join(root, 'channel');
  const w: World = {
    root,
    logFile: path.join(root, 'agent-log.ndjson'),
    ledger: await openConnectorStorage({ directory: ledgerState, mode: 'create', limits }),
    recorder: undefined as unknown as AcknowledgementRecorder,
    store: openChannelStore({ directory: channelState, mode: 'create' }),
    async restart() {
      await w.ledger.close();
      w.store.close();
      w.ledger = await openConnectorStorage({ directory: ledgerState, mode: 'existing', limits });
      w.recorder = createAcknowledgementRecorder(w.ledger);
      w.store = openChannelStore({ directory: channelState, mode: 'existing' });
    },
  };
  w.recorder = createAcknowledgementRecorder(w.ledger);
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  cleanup.push(async () => {
    await w.ledger.close();
    w.store.close();
  });
  seedChannel(w.store);
  await w.ledger.ledger.transaction(tx => tx.putBinding(BINDING));
  return w;
}

function seedChannel(handle: InternalStoreHandle): void {
  const store = createChannelStore(handle);
  store.registerParticipant({ participantId: HUMAN.participantId, ownerId: OWNER, kind: 'human', displayName: 'Owner' });
  store.registerParticipant({ participantId: AGENT.participantId, ownerId: OWNER, kind: 'agent', displayName: 'Agent' });
  store.registerDevice(HUMAN);
  store.registerDevice(AGENT);
  store.createChannel({
    operationId: 'op_channel', channelId: CHANNEL, title: null, creatorOwnerId: OWNER,
    creatorParticipantId: HUMAN.participantId, creatorDeviceId: HUMAN.deviceId, createdAt: '2026-09-25T10:00:00Z',
  });
  store.setMembership({ channelId: CHANNEL, participantId: AGENT.participantId, membership: 'joined' });
}

/** Sends one channel message per release and releases it to the agent binding in the ledger. */
async function release(w: World, releaseIds: readonly string[]): Promise<void> {
  const store = createChannelStore(w.store);
  for (const releaseId of releaseIds) {
    const content = { v: 1, kind: 'text', body: `${BODY_CANARY} ${releaseId}` } as const;
    const sent = store.send({
      channelId: CHANNEL, eventId: `event_${releaseId}` as EventId, authorParticipantId: HUMAN.participantId,
      authorDeviceId: HUMAN.deviceId, clientTxnId: `txn_${releaseId}`, content, receivedAt: '2026-09-25T10:01:00Z',
    });
    if (sent.kind !== 'stored') throw new Error(`send fixture: ${sent.kind}`);
    const plaintext = encodeMessageContent(content);
    const event: EventRef = {
      v: 1, roomId: CHANNEL, eventId: sent.event.eventId, authorParticipantId: HUMAN.participantId,
      authorDeviceId: HUMAN.deviceId, contentDigest: sha256Digest(plaintext),
    };
    await w.ledger.persistPending({
      key: { roomId: CHANNEL, eventId: event.eventId, recipientBindingId: BINDING.bindingId, recipientGeneration: 0 },
      event, plaintext, receivedAt: '2026-09-25T10:01:00Z', streamId: 'stream_1',
    });
    const approval: ApprovalCommand = {
      v: 1, commandId: `command_${releaseId}` as CommandId, roomId: CHANNEL, bindingId: BINDING.bindingId,
      expectedPolicyVersion: 1, expectedBindingGeneration: 0, selection: [event], issuedAt: '2026-09-25T10:02:00Z',
    };
    const payload = new TextEncoder().encode(`["${PAYLOAD_CANARY} ${releaseId}"]`);
    const job = releaseFromApproval({
      approval, items: [event], binding: BINDING, policyVersion: 1,
      release: {
        releaseId: releaseId as ReleaseId, payloadRef: newPayloadRef(), payloadDigest: sha256Digest(payload),
        causalRootId: 'cause_1' as CausalRootId,
      },
    });
    if (!job.ok) throw new Error(`release fixture: ${job.code}`);
    const expectedLedgerRevision = await w.ledger.ledger.transaction(tx => tx.ledgerRevision());
    const committed = await w.ledger.ledger.transaction(tx => tx.putRelease({
      command: {
        ownerId: OWNER, commandId: approval.commandId, inputDigest: sha256Digest(payload), command: approval,
        result: { ok: true, releaseIds: [releaseId as ReleaseId] },
      },
      job: job.value, payload, expectedLedgerRevision,
    }));
    if (committed.kind !== 'committed') throw new Error(`release fixture: ${committed.kind}`);
  }
}

/** The recipient inbox returned its token: record receipts, as `read-receipt-recording` does. */
async function acknowledge(w: World, releaseIds: readonly string[]) {
  const result = await w.recorder.recordBatchAcknowledgement({ principal: PRINCIPAL, releaseIds: releaseIds as ReleaseId[] });
  if (result.kind !== 'recorded') throw new Error(`acknowledge fixture: ${result.kind}`);
  return result;
}

function projector(w: World, overrides: Readonly<{ log?: ReceiptObservationLog; readModel?: ReceiptReadModel }> = {}) {
  if (!overrides.log && !overrides.readModel) {
    return createInternalReceiptProjector({ outbox: w.recorder, store: w.store, log: createNdjsonReceiptLog(w.logFile) });
  }
  return createReceiptProjector({
    outbox: w.recorder,
    readModel: overrides.readModel ?? createReceiptReadModel(w.store),
    log: overrides.log ?? createNdjsonReceiptLog(w.logFile),
  });
}

function logLines(w: World): unknown[] {
  if (!fs.existsSync(w.logFile)) return [];
  return fs.readFileSync(w.logFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as unknown);
}

function projectedRows(w: World) {
  return w.store.read(db => ({
    facts: db.prepare('SELECT * FROM receipt_facts ORDER BY receipt_id').all(),
    events: db.prepare('SELECT * FROM receipt_fact_events ORDER BY receipt_id, position').all(),
  }));
}

function channelReceipts(w: World, participantId: ParticipantId = HUMAN.participantId) {
  return createReceiptReadModel(w.store).channelReceipts({ channelId: CHANNEL, participantId });
}

const checkpointOf = (w: World) => createReceiptReadModel(w.store).readCheckpoint();

describe('receipt projection into the channel store and agent log', () => {
  it('projects a committed receipt after a crash even though the inbox cursor already advanced', async () => {
    const w = await world();
    await release(w, ['release_1']);
    const recorded = await acknowledge(w, ['release_1']);
    // The inbox advanced its cursor after the commit and the process died before any
    // projection ran. Nothing will ever replay this batch or call the recorder again.
    await w.restart();

    expect(await projector(w).drain()).toEqual({ kind: 'drained', checkpoint: expect.any(Number), projected: 1 });
    const result = channelReceipts(w);
    expect(result).toMatchObject({ kind: 'done' });
    if (result.kind !== 'done') return;
    expect(result.facts.map(fact => fact.receipt)).toEqual(recorded.receipts);
    expect(logLines(w)).toHaveLength(1);
  });

  it('recovers a crash between the channel-store write and the checkpoint without a second fact', async () => {
    for (const window of ['before log', 'before checkpoint'] as const) {
      const w = await world();
      await release(w, ['release_1', 'release_2']);
      await acknowledge(w, ['release_1', 'release_2']);
      const crash = async () => { throw new Error(`crash ${window}`); };
      const readModel = createReceiptReadModel(w.store);
      await expect(projector(w, window === 'before log'
        ? { log: { record: crash } }
        : { readModel: { ...readModel, projectReceipt: readModel.projectReceipt, commitCheckpoint: crash } },
      ).drain()).rejects.toThrow(`crash ${window}`);
      // Channel-store facts are durable but the checkpoint has not moved.
      const written = projectedRows(w);
      expect(written.facts.length).toBeGreaterThan(0);
      expect(await checkpointOf(w)).toBe(0);

      await w.restart();
      const resumed = await projector(w).drain();
      expect(resumed).toMatchObject({ kind: 'drained', projected: window === 'before log' ? 1 : 0 });
      expect(await checkpointOf(w)).toBe(resumed.checkpoint);
      const after = projectedRows(w);
      expect(after.facts).toHaveLength(2);
      expect(after.facts).toEqual(expect.arrayContaining(written.facts));
      // At-least-once: a repeated observation is byte-identical to the first.
      const lines = logLines(w);
      expect(new Set(lines.map(line => JSON.stringify(line))).size).toBe(2);
    }
  });

  it('does nothing new after the checkpoint, across repeated drains and restarts', async () => {
    const w = await world();
    await release(w, ['release_1', 'release_2', 'release_3']);
    await acknowledge(w, ['release_1', 'release_2']);
    await acknowledge(w, ['release_3']);
    expect(await projector(w).drain()).toMatchObject({ kind: 'drained', projected: 3 });
    const rows = projectedRows(w);
    const log = fs.readFileSync(w.logFile);
    const checkpoint = await checkpointOf(w);
    for (let round = 0; round < 3; round += 1) {
      await w.restart();
      expect(await projector(w).drain()).toEqual({ kind: 'drained', checkpoint, projected: 0 });
      expect(await projector(w).drain()).toEqual({ kind: 'drained', checkpoint, projected: 0 });
    }
    expect(projectedRows(w)).toEqual(rows);
    expect(fs.readFileSync(w.logFile)).toEqual(log);
  });

  it('groups a multi-release batch under one evidence reference and joins each fact to its channel event', async () => {
    const w = await world();
    await release(w, ['release_1', 'release_2', 'release_3', 'release_4']);
    const batch = await acknowledge(w, ['release_1', 'release_2', 'release_3']);
    const single = await acknowledge(w, ['release_4']);
    await projector(w).drain();

    const result = channelReceipts(w);
    if (result.kind !== 'done') throw new Error(result.kind);
    expect(result.groups).toEqual(expect.arrayContaining([
      { evidenceRef: batch.evidenceRef, receiptIds: expect.arrayContaining(batch.receipts.map(r => r.receiptId)) },
      { evidenceRef: single.evidenceRef, receiptIds: [single.receipts[0]!.receiptId] },
    ]));
    expect(result.groups).toHaveLength(2);
    const timeline = createChannelStore(w.store).timeline({
      channelId: CHANNEL, participantId: HUMAN.participantId, reader: { kind: 'member' }, cursor: null, limit: 10,
    });
    if (timeline.kind !== 'done') throw new Error(timeline.kind);
    const sequenceOf = new Map(timeline.events.map(event => [event.eventId, event.sequence]));
    for (const fact of result.facts) {
      expect(fact.events).toEqual([{
        eventId: `event_${fact.receipt.releaseId}`, sequence: sequenceOf.get(`event_${fact.receipt.releaseId}` as EventId),
      }]);
    }
    // Only joined members read channel evidence.
    createChannelStore(w.store).setMembership({ channelId: CHANNEL, participantId: AGENT.participantId, membership: 'left' });
    expect(channelReceipts(w, AGENT.participantId)).toEqual({ kind: 'rejected', code: 'not_joined' });
  });

  it('keeps the first fact when a duplicate projection disagrees, and fails closed', async () => {
    const w = await world();
    await release(w, ['release_1', 'release_2']);
    const first = await acknowledge(w, ['release_1']);
    await acknowledge(w, ['release_2']);
    const readModel = createReceiptReadModel(w.store);
    const outbox = await w.recorder.readReceiptOutbox();
    const fact = {
      receipt: outbox[0]!.receipt, evidenceRef: outbox[0]!.evidenceRef, ledgerRevision: outbox[0]!.ledgerRevision,
      events: outbox[0]!.events.map(event => ({ channelId: event.roomId, eventId: event.eventId })),
    };
    expect(await readModel.projectReceipt(fact)).toEqual({ kind: 'stored' });
    expect(await readModel.projectReceipt(fact)).toEqual({ kind: 'duplicate' });
    const before = projectedRows(w);
    for (const changed of [
      { ...fact, evidenceRef: 'ack_other', receipt: { ...fact.receipt, evidenceRef: 'ack_other' } },
      { ...fact, receipt: { ...fact.receipt, observedAt: '2026-09-25T13:00:00Z' } },
      { ...fact, ledgerRevision: fact.ledgerRevision + 1 },
      { ...fact, events: [{ channelId: CHANNEL, eventId: 'event_release_2' as EventId }] },
    ]) expect(await readModel.projectReceipt(changed)).toEqual({ kind: 'conflict' });
    expect(projectedRows(w)).toEqual(before);

    // A conflicting row already in the read model stops the drain before its revision.
    w.store.transaction(db => db.prepare("UPDATE receipt_facts SET evidence_ref = 'ack_tampered'").run());
    expect(await projector(w).drain()).toEqual({ kind: 'conflict', checkpoint: 0, receiptId: first.receipts[0]!.receiptId });
    expect(await checkpointOf(w)).toBe(0);
    expect(projectedRows(w).facts).toHaveLength(1);
  });

  it('writes a closed, content-free log schema and keeps secrets out of the projection', async () => {
    const w = await world();
    await release(w, ['release_1', 'release_2']);
    const recorded = await acknowledge(w, ['release_1', 'release_2']);
    await projector(w).drain();

    const lines = logLines(w);
    expect(lines).toEqual(recorded.receipts.map(receipt => ({
      v: 1, event: RECEIPT_OBSERVATION_EVENT, receiptId: receipt.receiptId, releaseId: receipt.releaseId,
      bindingId: BINDING.bindingId, generation: 0, kind: 'agent_acknowledged', source: 'agent',
      observedAt: receipt.observedAt, evidenceRef: recorded.evidenceRef, ledgerRevision: expect.any(Number),
      events: [{ channelId: CHANNEL, eventId: `event_${receipt.releaseId}` }],
    })));
    expect(fs.statSync(w.logFile).mode & 0o777).toBe(0o600);

    const surfaces = [fs.readFileSync(w.logFile, 'utf8'), JSON.stringify(projectedRows(w)), JSON.stringify(channelReceipts(w))];
    for (const surface of surfaces) {
      for (const canary of [BODY_CANARY, PAYLOAD_CANARY, TOKEN_CANARY, 'sha256:', 'payload_']) {
        expect(surface).not.toContain(canary);
      }
    }
  });
});
