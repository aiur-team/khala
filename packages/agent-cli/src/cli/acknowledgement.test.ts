// The batch-token acknowledgement across both durability domains: the recipient's
// JSONL inbox owns the token and cursor, the connector's SQLite ledger owns the
// receipts. Every test uses the real inbox and the real ledger on disk.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ApprovalCommand, type BindingId, type CausalRootId, type CommandId, type DeviceId, type EventId, type EventRef,
  type OwnerId, type ParticipantId, type ReleaseId, type RoomId, type SessionBinding,
  decodeDeliveryLimits, decodeSessionBinding, releaseFromApproval,
} from '@khala/contracts/delivery/index';
import { encodeMessageContent } from '@khala/contracts/messaging/events';
import {
  acceptBatchAcknowledgement, createAcknowledgementRecorder, type AcknowledgementRecorder, type AgentPrincipal,
} from '@khala/connector/storage/acknowledgements';
import { type ConnectorStorage, openConnectorStorage } from '@khala/connector/storage/open';
import { newPayloadRef, sha256Digest } from '@khala/connector/storage/payloads';
import { runCli } from './app.js';
import { CliError } from './errors.js';
import { openInbox, type BatchAcknowledgementRecorder, type BatchInbox } from './inbox.js';
import type { AgentClientPort, InboxDelivery } from './types.js';

const decodedLimits = decodeDeliveryLimits({ maxSelectionEvents: 20, maxPayloadBytes: 64 * 1024 });
if (!decodedLimits.ok) throw new Error('limits fixture');
const limits = decodedLimits.value;

function sessionBinding(bindingId: string): SessionBinding {
  const decoded = decodeSessionBinding({
    v: 1, bindingId, ownerId: 'owner_a', agentParticipantId: `participant_${bindingId}`, deviceId: 'device_connector',
    harness: 'codex', sessionId: `session_${bindingId}`, generation: 0,
  });
  if (!decoded.ok) throw new Error('binding fixture');
  return decoded.value;
}

const AGENT_A = sessionBinding('binding_a');
const AGENT_B = sessionBinding('binding_b');
const principalOf = (binding: SessionBinding): AgentPrincipal => ({ bindingId: binding.bindingId, generation: binding.generation });

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

type World = Readonly<{
  root: string;
  inboxState: string;
  ledgerState: string;
  storage: () => ConnectorStorage;
  recorder: () => AcknowledgementRecorder;
  reopenLedger: () => Promise<void>;
}>;

async function world(): Promise<World> {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-ack-'));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const ledgerState = path.join(root, 'ledger');
  let storage = await openConnectorStorage({ directory: ledgerState, mode: 'create', limits });
  let recorder = createAcknowledgementRecorder(storage);
  cleanup.push(() => storage.close());
  return {
    root,
    inboxState: path.join(root, 'inbox'),
    ledgerState,
    storage: () => storage,
    recorder: () => recorder,
    async reopenLedger() {
      await storage.close();
      storage = await openConnectorStorage({ directory: ledgerState, mode: 'existing', limits });
      recorder = createAcknowledgementRecorder(storage);
    },
  };
}

/** Releases one job per ID to `binding` in the ledger, and delivers it to that binding's inbox. */
async function release(w: World, binding: SessionBinding, releaseIds: readonly string[]): Promise<void> {
  const storage = w.storage();
  await storage.ledger.transaction(tx => tx.putBinding(binding));
  const inbox = await openInbox(inboxOptions(w, binding));
  for (const releaseId of releaseIds) {
    const body = `secret body ${releaseId}`;
    const plaintext = encodeMessageContent({ v: 1, kind: 'text', body });
    const event: EventRef = {
      v: 1, roomId: 'room_1' as RoomId, eventId: `event_${releaseId}` as EventId,
      authorParticipantId: 'participant_human' as ParticipantId, authorDeviceId: 'device_human' as DeviceId,
      contentDigest: sha256Digest(plaintext),
    };
    await storage.persistPending({
      key: { roomId: event.roomId, eventId: event.eventId, recipientBindingId: binding.bindingId, recipientGeneration: 0 },
      event, plaintext, receivedAt: '2026-09-25T10:00:00Z', streamId: 'stream_1',
    });
    const approval: ApprovalCommand = {
      v: 1, commandId: `command_${releaseId}` as CommandId, roomId: event.roomId, bindingId: binding.bindingId,
      expectedPolicyVersion: 1, expectedBindingGeneration: 0, selection: [event], issuedAt: '2026-09-25T10:01:00Z',
    };
    const payload = new TextEncoder().encode(`["secret payload ${releaseId}"]`);
    const job = releaseFromApproval({
      approval, items: [event], binding, policyVersion: 1,
      release: {
        releaseId: releaseId as ReleaseId, payloadRef: newPayloadRef(), payloadDigest: sha256Digest(payload),
        causalRootId: 'cause_1' as CausalRootId,
      },
    });
    if (!job.ok) throw new Error(`release fixture: ${job.code}`);
    const expectedLedgerRevision = await storage.ledger.transaction(tx => tx.ledgerRevision());
    const committed = await storage.ledger.transaction(tx => tx.putRelease({
      command: {
        ownerId: binding.ownerId as OwnerId, commandId: approval.commandId, inputDigest: sha256Digest(payload), command: approval,
        result: { ok: true, releaseIds: [releaseId as ReleaseId] },
      },
      job: job.value, payload, expectedLedgerRevision,
    }));
    if (committed.kind !== 'committed') throw new Error(`release fixture: ${committed.kind}`);
    const delivery: InboxDelivery = {
      v: 1, releaseId, bindingId: binding.bindingId as BindingId, generation: 0, events: [event],
      payloadDigest: sha256Digest(payload), payload, receivedAt: '2026-09-25T10:02:00Z',
    };
    await inbox.enqueue(delivery);
  }
}

/**
 * The consumer hook as the authenticated transport composes it: the principal is the
 * binding the transport authenticated for this inbox, never a value from the call.
 */
function transportHook(w: World, authenticated: SessionBinding | null): BatchAcknowledgementRecorder {
  return async acknowledgement => {
    const result = await acceptBatchAcknowledgement(
      w.recorder(), authenticated === null ? null : principalOf(authenticated), acknowledgement,
    );
    if (result.kind === 'refused') throw new CliError(result.code);
  };
}

function inboxOptions(w: World, binding: SessionBinding, recordAcknowledgement?: BatchAcknowledgementRecorder) {
  return {
    stateDirectory: w.inboxState, bindingId: binding.bindingId, generation: binding.generation,
    maxPayloadBytes: 4096, maxSelectionEvents: 8,
    ...(recordAcknowledgement === undefined ? {} : { recordAcknowledgement }),
  };
}

async function consumer(w: World, binding: SessionBinding, hook: BatchAcknowledgementRecorder | undefined = transportHook(w, binding)) {
  const inbox = await openInbox(inboxOptions(w, binding, hook));
  const lease = await inbox.acquireListener();
  cleanup.push(() => lease.release());
  return { inbox, lease };
}

async function agentReceipts(w: World, releaseIds: readonly string[]) {
  return w.storage().ledger.transaction(tx => releaseIds.flatMap(releaseId => tx.readReceipts(releaseId as ReleaseId))
    .map(stored => stored.receipt).filter(receipt => receipt.kind === 'agent_acknowledged'));
}

function bindingDirectory(w: World, binding: SessionBinding): string {
  return path.join(w.inboxState, 'bindings',
    createHash('sha256').update(JSON.stringify([binding.bindingId, binding.generation])).digest('base64url'));
}

describe('batch-token acknowledgement recording', () => {
  it('creates no receipt from issuing, re-reading, or returning a batch response alone', async () => {
    const w = await world();
    await release(w, AGENT_A, ['release_1']);
    const { lease } = await consumer(w, AGENT_A);

    const issued = await lease.readBatch({ maxBytes: 4096 });
    expect(issued?.items.map(item => item.record.releaseId)).toEqual(['release_1']);
    expect(await lease.readBatch({ maxBytes: 4096 })).toEqual(issued);
    expect(await lease.readBatch({ maxBytes: 4096, acknowledgeToken: null })).toEqual(issued);

    expect(await agentReceipts(w, ['release_1'])).toEqual([]);
    expect(await w.recorder().readReceiptOutbox()).toEqual([]);
  });

  it('records receipts for exactly the batch prefix on the next token-bearing call, then advances', async () => {
    const w = await world();
    await release(w, AGENT_A, ['release_1', 'release_2', 'release_3']);
    const { inbox, lease } = await consumer(w, AGENT_A);

    const first = await lease.readBatch({ maxBytes: 70 });
    const acknowledged = first!.items.map(item => item.record.releaseId);
    expect(acknowledged).toEqual(['release_1', 'release_2']);

    const next = await lease.readBatch({ maxBytes: 4096, acknowledgeToken: first!.token });

    expect(next?.items.map(item => item.record.releaseId)).toEqual(['release_3']);
    const receipts = await agentReceipts(w, ['release_1', 'release_2', 'release_3']);
    expect(receipts.map(receipt => receipt.releaseId)).toEqual(acknowledged);
    expect(new Set(receipts.map(receipt => receipt.evidenceRef)).size).toBe(1);
    expect(receipts.every(receipt => receipt.bindingId === AGENT_A.bindingId && receipt.generation === 0)).toBe(true);
    expect((await inbox.status()).cursor.releaseId).toBe('release_2');
  });

  it('refuses a missing or wrong token with no receipt and no cursor advance', async () => {
    const w = await world();
    await release(w, AGENT_A, ['release_1']);
    const { inbox, lease } = await consumer(w, AGENT_A);
    const issued = await lease.readBatch({ maxBytes: 4096 });
    const before = await inbox.status();

    for (const acknowledgeToken of [undefined, null, 'wrong-token', `${issued!.token}x`]) {
      expect(await lease.readBatch({ maxBytes: 4096, ...(acknowledgeToken === undefined ? {} : { acknowledgeToken }) }))
        .toEqual(issued);
    }

    expect(await inbox.status()).toEqual(before);
    expect(await agentReceipts(w, ['release_1'])).toEqual([]);
  });

  it('lets agent B neither return agent A\'s token nor acknowledge A\'s releases through its own binding', async () => {
    const w = await world();
    await release(w, AGENT_A, ['release_a']);
    await release(w, AGENT_B, ['release_b']);
    const a = await consumer(w, AGENT_A);
    const b = await consumer(w, AGENT_B);
    const aBatch = await a.lease.readBatch({ maxBytes: 4096 });
    const bBatch = await b.lease.readBatch({ maxBytes: 4096 });

    expect(await b.lease.readBatch({ maxBytes: 4096, acknowledgeToken: aBatch!.token })).toEqual(bBatch);
    expect(await agentReceipts(w, ['release_a', 'release_b'])).toEqual([]);

    // A's inbox reached through B's authenticated credential cannot acknowledge either.
    const forged = await openInbox(inboxOptions(w, AGENT_A, transportHook(w, AGENT_B)));
    await a.lease.release();
    const forgedLease = await forged.acquireListener();
    cleanup.push(() => forgedLease.release());
    await expect(forgedLease.readBatch({ maxBytes: 4096, acknowledgeToken: aBatch!.token }))
      .rejects.toMatchObject({ code: 'binding_not_held' });
    expect(await agentReceipts(w, ['release_a'])).toEqual([]);
    expect((await forged.status()).cursor.releaseId).toBeNull();
  });

  it('refuses an unauthenticated call and a revoked binding with no receipt and no cursor advance', async () => {
    const w = await world();
    await release(w, AGENT_A, ['release_1']);
    const anonymous = await openInbox(inboxOptions(w, AGENT_A, transportHook(w, null)));
    const lease = await anonymous.acquireListener();
    cleanup.push(() => lease.release());
    const issued = await lease.readBatch({ maxBytes: 4096 });

    await expect(lease.readBatch({ maxBytes: 4096, acknowledgeToken: issued!.token }))
      .rejects.toMatchObject({ code: 'binding_not_held' });
    await w.storage().ledger.transaction(tx => tx.putRevocation({
      targetKind: 'binding', targetId: AGENT_A.bindingId, generation: 0, operationId: 'op_stop', revokedAt: '2026-09-25T11:00:00Z',
    }));
    await lease.release();
    const revoked = await consumer(w, AGENT_A);
    await expect(revoked.lease.readBatch({ maxBytes: 4096, acknowledgeToken: issued!.token }))
      .rejects.toMatchObject({ code: 'binding_not_held' });

    expect(await agentReceipts(w, ['release_1'])).toEqual([]);
    expect((await revoked.inbox.status()).cursor.releaseId).toBeNull();
    expect(await revoked.lease.readBatch({ maxBytes: 4096 })).toEqual(issued);
  });
});

describe('crash windows', () => {
  it('crash before receipt commit: nothing recorded, cursor unchanged, the same batch replays and later commits', async () => {
    const w = await world();
    await release(w, AGENT_A, ['release_1']);
    const crashing = await consumer(w, AGENT_A, async () => { throw new Error('process died before commit'); });
    const issued = await crashing.lease.readBatch({ maxBytes: 4096 });

    await expect(crashing.lease.readBatch({ maxBytes: 4096, acknowledgeToken: issued!.token }))
      .rejects.toMatchObject({ code: 'storage_failed' });
    expect(await agentReceipts(w, ['release_1'])).toEqual([]);
    expect((await crashing.inbox.status()).cursor.releaseId).toBeNull();
    await crashing.lease.release();

    const restarted = await consumer(w, AGENT_A);
    expect(await restarted.lease.readBatch({ maxBytes: 4096 })).toEqual(issued);
    expect(await restarted.lease.readBatch({ maxBytes: 4096, acknowledgeToken: issued!.token })).toBeNull();
    expect(await agentReceipts(w, ['release_1'])).toHaveLength(1);
  });

  it('crash between receipt commit and cursor advance: replay reuses the original immutable receipts', async () => {
    const w = await world();
    await release(w, AGENT_A, ['release_1', 'release_2']);
    const commitThenDie: BatchAcknowledgementRecorder = async acknowledgement => {
      await transportHook(w, AGENT_A)(acknowledgement);
      throw new Error('process died after commit');
    };
    const crashing = await consumer(w, AGENT_A, commitThenDie);
    const issued = await crashing.lease.readBatch({ maxBytes: 4096 });
    await expect(crashing.lease.readBatch({ maxBytes: 4096, acknowledgeToken: issued!.token })).rejects.toThrow();
    const committed = await agentReceipts(w, ['release_1', 'release_2']);
    expect(committed).toHaveLength(2);
    expect((await crashing.inbox.status()).cursor.releaseId).toBeNull();
    await crashing.lease.release();
    await w.reopenLedger();

    const restarted = await consumer(w, AGENT_A);
    const replayed = await restarted.lease.readBatch({ maxBytes: 4096 });
    expect(replayed).toEqual(issued);
    expect(await restarted.lease.readBatch({ maxBytes: 4096, acknowledgeToken: replayed!.token })).toBeNull();

    const after = await agentReceipts(w, ['release_1', 'release_2']);
    expect(JSON.stringify(after)).toBe(JSON.stringify(committed));
    expect(await w.recorder().readReceiptOutbox()).toHaveLength(2);
    expect((await restarted.inbox.status()).cursor.releaseId).toBe('release_2');
  });

  it('crash after cursor advance: the committed cursor never replays the batch', async () => {
    const w = await world();
    await release(w, AGENT_A, ['release_1']);
    const first = await consumer(w, AGENT_A);
    const issued = await first.lease.readBatch({ maxBytes: 4096 });
    const batchFile = path.join(bindingDirectory(w, AGENT_A), 'batch.json');
    const outstanding = fs.readFileSync(batchFile);
    expect(await first.lease.readBatch({ maxBytes: 4096, acknowledgeToken: issued!.token })).toBeNull();
    await first.lease.release();

    // The process died after the cursor rename but before the batch state was removed.
    fs.writeFileSync(batchFile, outstanding, { mode: 0o600 });
    const restarted = await consumer(w, AGENT_A, async () => { throw new Error('must not be asked again'); });
    expect(await restarted.lease.readBatch({ maxBytes: 4096 })).toBeNull();
    expect(await restarted.lease.readBatch({ maxBytes: 4096, acknowledgeToken: issued!.token })).toBeNull();
    expect(await agentReceipts(w, ['release_1'])).toHaveLength(1);
  });

  it('redelivers across restart with no host-side deduplication: repeated enqueue is the inbox\'s own duplicate', async () => {
    const w = await world();
    await release(w, AGENT_A, ['release_1']);
    const first = await consumer(w, AGENT_A);
    const issued = await first.lease.readBatch({ maxBytes: 4096 });
    await first.lease.release();
    const restarted = await consumer(w, AGENT_A);
    expect(await restarted.lease.readBatch({ maxBytes: 4096 })).toEqual(issued);
    expect(await restarted.lease.readBatch({ maxBytes: 4096, acknowledgeToken: issued!.token })).toBeNull();
    expect(await agentReceipts(w, ['release_1'])).toHaveLength(1);
  });
});

describe('shared MCP call envelope', () => {
  function client(binding: SessionBinding, send: AgentClientPort['send']): AgentClientPort {
    return {
      async connect() { return { kind: 'connected', binding, reused: false }; },
      send,
      async status() { return { v: 1, connected: true, binding, route: 'unknown', sourceCursor: null }; },
      async listChannels() { throw new Error('listing is not under test'); },
      async listAgents() { throw new Error('listing is not under test'); },
    };
  }

  async function session(w: World, send: AgentClientPort['send'], calls: readonly Record<string, unknown>[]) {
    const stdin = new PassThrough(); stdin.end(calls.map(call => JSON.stringify(call)).join('\n') + '\n');
    const stdout = new PassThrough(); const stderr = new PassThrough();
    let out = ''; let err = '';
    stdout.on('data', chunk => { out += String(chunk); }); stderr.on('data', chunk => { err += String(chunk); });
    const inbox = (): Promise<BatchInbox> => openInbox(inboxOptions(w, AGENT_A, transportHook(w, AGENT_A)));
    expect(await runCli(['mcp-serve'], { client: client(AGENT_A, send), inbox, stdin, stdout, stderr })).toBe(0);
    return { responses: out.trim().split('\n').map(line => JSON.parse(line)), stderr: err };
  }

  const call = (id: number, name: 'khala_read' | 'khala_send', ackBatchToken?: string) => ({
    jsonrpc: '2.0', id, method: 'tools/call', params: {
      name, arguments: { ...(name === 'khala_send' ? { message: `reply ${id}` } : {}), ...(ackBatchToken ? { ackBatchToken } : {}) },
    },
  });
  const tokenOf = (response: { result: { content: { text: string }[] } }) =>
    response.result.content.at(-1)!.text.match(/batchToken: ([^\n]+)/)![1]!;

  it('records the acknowledgement from ackBatchToken on the next khala_read', async () => {
    const w = await world();
    await release(w, AGENT_A, ['release_1']);
    const accept: AgentClientPort['send'] = async input => ({ kind: 'accepted', clientTxnId: input.clientTxnId, eventId: 'event_r' });
    const first = await session(w, accept, [call(1, 'khala_read')]);
    expect(await agentReceipts(w, ['release_1'])).toEqual([]);

    const token = tokenOf(first.responses[0]);
    const second = await session(w, accept, [call(2, 'khala_read', token)]);
    expect(second.responses[0].result.structuredContent).toMatchObject({ kind: 'empty' });
    expect(await agentReceipts(w, ['release_1'])).toHaveLength(1);
    expect(first.stderr + second.stderr).not.toContain(token);
  });

  it('commits a valid acknowledgement on khala_send even when the primary operation is refused', async () => {
    const w = await world();
    await release(w, AGENT_A, ['release_1']);
    const accept: AgentClientPort['send'] = async input => ({ kind: 'accepted', clientTxnId: input.clientTxnId, eventId: 'event_r' });
    const refuse: AgentClientPort['send'] = async input => ({ kind: 'refused', code: 'transport_unavailable', clientTxnId: input.clientTxnId });
    const first = await session(w, accept, [call(1, 'khala_read')]);
    const token = tokenOf(first.responses[0]);

    const refused = await session(w, refuse, [call(2, 'khala_send', token)]);

    expect(refused.responses[0].result.isError).toBe(true);
    expect(await agentReceipts(w, ['release_1'])).toHaveLength(1);
    const inbox = await openInbox(inboxOptions(w, AGENT_A));
    expect((await inbox.status()).cursor.releaseId).toBe('release_1');
  });

  it('keeps the token and message content out of receipts, the outbox, the ledger files and errors', async () => {
    const w = await world();
    await release(w, AGENT_A, ['release_1']);
    const refuse: AgentClientPort['send'] = async input => ({ kind: 'refused', code: 'binding_not_held', clientTxnId: input.clientTxnId });
    const first = await session(w, refuse, [call(1, 'khala_read')]);
    const token = tokenOf(first.responses[0]);
    const second = await session(w, refuse, [call(2, 'khala_send', token), call(3, 'khala_send', 'wrong-token')]);

    const receipts = JSON.stringify(await agentReceipts(w, ['release_1']));
    const outbox = JSON.stringify(await w.recorder().readReceiptOutbox());
    for (const text of [receipts, outbox]) {
      expect(text).not.toContain(token);
      expect(text).not.toContain('secret');
    }
    for (const response of second.responses) expect(JSON.stringify(response.result.structuredContent)).not.toContain(token);
    expect(second.stderr).not.toContain(token);
    await w.storage().close();
    for (const file of fs.readdirSync(w.ledgerState)) {
      expect(fs.readFileSync(path.join(w.ledgerState, file)).includes(Buffer.from(token))).toBe(false);
    }
    await w.reopenLedger();
  });
});
