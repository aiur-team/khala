// OpenCode acknowledgement conformance: the real bridge over the real inbox and the
// real connector receipt ledger. Only the agent's next authenticated Khala call
// (khala_read / khala_send echoing ackBatchToken) may produce `agent_acknowledged`.
// Delivery, context hooks and batch responses must never do so.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ApprovalCommand, type BindingId, type CausalRootId, type CommandId, type DeviceId, type EventId, type EventRef,
  type OwnerId, type ParticipantId, type ReleaseId, type RoomId, type SessionBinding,
  decodeDeliveryLimits, decodeSessionBinding, releaseFromApproval,
} from '@khala/contracts/delivery/index';
import { encodeMessageContent } from '@khala/contracts/messaging/events';
import {
  acceptBatchAcknowledgement, createAcknowledgementRecorder, type AcknowledgementRecorder,
} from '@khala/connector/storage/acknowledgements';
import { type ConnectorStorage, openConnectorStorage } from '@khala/connector/storage/open';
import { newPayloadRef, sha256Digest } from '@khala/connector/storage/payloads';
import { CliError } from '../cli/errors.js';
import { type BatchInbox, type WakeableInboxConsumer, openInbox } from '../cli/inbox.js';
import type { InboxDelivery } from '../cli/types.js';
import { OpenCodeSessionBridge } from './bridge.js';
import { FakeControls, FakeOpenCode, FakeSend, envelopeTokens } from './fakes.js';
import { openOpenCodeBridgeStore } from './store.js';

const limitsResult = decodeDeliveryLimits({ maxSelectionEvents: 20, maxPayloadBytes: 64 * 1024 });
if (!limitsResult.ok) throw new Error('limits fixture');
const limits = limitsResult.value;

const SESSION = 'ses_A';
function bindingFor(bindingId: string, generation = 0): SessionBinding {
  const decoded = decodeSessionBinding({
    v: 1, bindingId, ownerId: 'owner_a', agentParticipantId: `participant_${bindingId}`, deviceId: 'device_connector',
    harness: 'opencode', sessionId: SESSION, generation,
  });
  if (!decoded.ok) throw new Error('binding fixture');
  return decoded.value;
}
const BINDING = bindingFor('binding_oc');
const OTHER = bindingFor('binding_other');

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

type World = Readonly<{ root: string; storage: ConnectorStorage; recorder: AcknowledgementRecorder }>;

async function world(): Promise<World> {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-oc-receipts-'));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const storage = await openConnectorStorage({ directory: path.join(root, 'ledger'), mode: 'create', limits });
  cleanup.push(() => storage.close());
  return { root, storage, recorder: createAcknowledgementRecorder(storage) };
}

/** Commits one release to the ledger for `binding` and enqueues its delivery in the inbox. */
async function release(w: World, inbox: BatchInbox, binding: SessionBinding, releaseId: string): Promise<void> {
  await w.storage.ledger.transaction(tx => tx.putBinding(binding));
  const plaintext = encodeMessageContent({ v: 1, kind: 'text', body: `body ${releaseId}` });
  const event: EventRef = {
    v: 1, roomId: 'room_1' as RoomId, eventId: `event_${releaseId}` as EventId,
    authorParticipantId: 'participant_human' as ParticipantId, authorDeviceId: 'device_human' as DeviceId,
    contentDigest: sha256Digest(plaintext),
  };
  await w.storage.persistPending({
    key: { roomId: event.roomId, eventId: event.eventId, recipientBindingId: binding.bindingId, recipientGeneration: binding.generation },
    event, plaintext, receivedAt: '2026-09-25T10:00:00Z', streamId: 'stream_1',
  });
  const approval: ApprovalCommand = {
    v: 1, commandId: `command_${releaseId}` as CommandId, roomId: event.roomId, bindingId: binding.bindingId,
    expectedPolicyVersion: 1, expectedBindingGeneration: binding.generation, selection: [event], issuedAt: '2026-09-25T10:01:00Z',
  };
  const payload = new TextEncoder().encode(JSON.stringify({ channel: 'room_1', sender: 'human', body: `body ${releaseId}` }));
  const job = releaseFromApproval({
    approval, items: [event], binding, policyVersion: 1,
    release: {
      releaseId: releaseId as ReleaseId, payloadRef: newPayloadRef(), payloadDigest: sha256Digest(payload),
      causalRootId: 'cause_1' as CausalRootId,
    },
  });
  if (!job.ok) throw new Error(`release fixture: ${job.code}`);
  const expectedLedgerRevision = await w.storage.ledger.transaction(tx => tx.ledgerRevision());
  const committed = await w.storage.ledger.transaction(tx => tx.putRelease({
    command: {
      ownerId: binding.ownerId as OwnerId, commandId: approval.commandId, inputDigest: sha256Digest(payload), command: approval,
      result: { ok: true, releaseIds: [releaseId as ReleaseId] },
    },
    job: job.value, payload, expectedLedgerRevision,
  }));
  if (committed.kind !== 'committed') throw new Error(`release fixture: ${committed.kind}`);
  const delivery: InboxDelivery = {
    v: 1, releaseId, bindingId: binding.bindingId as BindingId, generation: binding.generation, events: [event],
    payloadDigest: sha256Digest(payload), payload, receivedAt: '2026-09-25T10:02:00Z',
  };
  await inbox.enqueue(delivery);
}

type Mode = 'steer' | 'sync' | 'async';

/** A bridge over a real inbox whose acknowledgement hook is bound to `authenticated`, as the transport binds it. */
async function tui(w: World, binding: SessionBinding, authenticated: SessionBinding | null = binding, mode: Mode = 'sync') {
  const inbox = await openInbox({
    stateDirectory: path.join(w.root, 'inbox'), bindingId: binding.bindingId, generation: binding.generation,
    maxPayloadBytes: 4096, maxSelectionEvents: 8,
    recordAcknowledgement: async acknowledgement => {
      const result = await acceptBatchAcknowledgement(
        w.recorder,
        authenticated === null ? null : { bindingId: authenticated.bindingId, generation: authenticated.generation },
        acknowledgement,
      );
      if (result.kind === 'refused') throw new CliError(result.code);
    },
  });
  const opencode = new FakeOpenCode([SESSION]);
  const controls = new FakeControls(binding, mode);
  const t = {
    inbox, opencode,
    consumer: null as unknown as WakeableInboxConsumer,
    bridge: null as unknown as OpenCodeSessionBridge,
    async start() {
      t.consumer = await inbox.acquireListener();
      const consumer = t.consumer;
      cleanup.push(() => consumer.release());
      const store = await openOpenCodeBridgeStore({
        stateDirectory: path.join(w.root, 'bridge'), bindingId: binding.bindingId, generation: binding.generation,
      });
      t.bridge = new OpenCodeSessionBridge({
        binding, batch: consumer, session: opencode, controls, send: new FakeSend(), store,
        runtime: { version: '1.17.10', directory: '/work/project' },
      });
    },
    async restart() {
      await t.consumer.release();
      await t.start();
    },
  };
  await t.start();
  return t;
}
type Tui = Awaited<ReturnType<typeof tui>>;

async function acknowledged(w: World, releaseIds: readonly string[]) {
  return w.storage.ledger.transaction(tx => releaseIds.flatMap(id => tx.readReceipts(id as ReleaseId))
    .map(stored => stored.receipt).filter(receipt => receipt.kind === 'agent_acknowledged'));
}

/** The token of the envelope in a `khala_read` result. */
function tokenOf(toolResult: string): string {
  const text = toolResult.split('\n\n').slice(1).join('\n\n');
  const [token] = envelopeTokens([{ info: { id: 'm', sessionID: SESSION, role: 'user' }, parts: [{ type: 'text', text }] }]);
  if (token === undefined) throw new Error(`no envelope in ${toolResult}`);
  return token;
}

/** Idle route: the batch reaches the session as a stored prompt. Returns its token. */
async function deliverIdle(t: Tui): Promise<string> {
  t.opencode.userTurn(SESSION, 'join');
  t.opencode.statuses.set(SESSION, 'idle');
  await t.bridge.wake('hint');
  const tokens = envelopeTokens(t.opencode.context(SESSION));
  expect(tokens).toHaveLength(1);
  return tokens[0]!;
}

describe('OpenCode next-call acknowledgement', () => {
  it('idle: delivery, the stored prompt and a repeated hint acknowledge nothing; the next khala_read does', async () => {
    const w = await world();
    const t = await tui(w, BINDING);
    await release(w, t.inbox, BINDING, 'release_1');
    const token = await deliverIdle(t);
    await t.bridge.wake('hint');

    expect(await acknowledged(w, ['release_1'])).toEqual([]);
    expect(await w.recorder.readReceiptOutbox()).toEqual([]);

    const reply = await t.bridge.read({ sessionID: SESSION, ackBatchToken: token });
    expect(JSON.parse(reply)).toEqual({ kind: 'empty' });
    const receipts = await acknowledged(w, ['release_1']);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ bindingId: BINDING.bindingId, generation: 0, releaseId: 'release_1' });
    expect(JSON.stringify([receipts, await w.recorder.readReceiptOutbox()])).not.toContain(token);
  });

  it('busy steer: the marked, transformed batch is a delivery claim only; khala_send returning the token acknowledges', async () => {
    const w = await world();
    const t = await tui(w, BINDING, BINDING, 'steer');
    t.opencode.userTurn(SESSION, 'run bash twice');
    await release(w, t.inbox, BINDING, 'release_1');
    t.opencode.toolResult(SESSION, 'bash 1 done');
    await t.bridge.afterTool({ sessionID: SESSION, tool: 'bash' });
    const context = t.opencode.context(SESSION);
    await t.bridge.transformMessages(context);
    const [token] = envelopeTokens(context);
    expect(token).toBeDefined();
    expect(await acknowledged(w, ['release_1'])).toEqual([]);

    await t.bridge.sendMessage({ sessionID: SESSION, message: 'ack', ackBatchToken: token });
    expect(await acknowledged(w, ['release_1'])).toHaveLength(1);
  });

  it('no later Khala call stays neutral: no receipt, and the batch is still outstanding', async () => {
    const w = await world();
    const t = await tui(w, BINDING);
    await release(w, t.inbox, BINDING, 'release_1');
    const token = await deliverIdle(t);
    await t.bridge.wake('hint');

    expect(await acknowledged(w, ['release_1'])).toEqual([]);
    expect((await t.consumer.readBatch({ maxBytes: 4096 }))?.token).toBe(token);
  });

  it('missing token: khala_read without ackBatchToken re-returns the batch and acknowledges nothing', async () => {
    const w = await world();
    const t = await tui(w, BINDING, BINDING, 'async');
    await release(w, t.inbox, BINDING, 'release_1');
    const first = await t.bridge.read({ sessionID: SESSION });
    expect(await t.bridge.read({ sessionID: SESSION })).toEqual(first);
    expect(await acknowledged(w, ['release_1'])).toEqual([]);
  });

  it('a duplicate or replayed token never creates a second receipt', async () => {
    const w = await world();
    const t = await tui(w, BINDING, BINDING, 'async');
    await release(w, t.inbox, BINDING, 'release_1');
    const token = tokenOf(await t.bridge.read({ sessionID: SESSION }));

    await t.bridge.read({ sessionID: SESSION, ackBatchToken: token });
    const before = JSON.stringify(await acknowledged(w, ['release_1']));
    await t.bridge.read({ sessionID: SESSION, ackBatchToken: token });
    await t.bridge.sendMessage({ sessionID: SESSION, message: 'again', ackBatchToken: token });

    expect(await acknowledged(w, ['release_1'])).toHaveLength(1);
    expect(JSON.stringify(await acknowledged(w, ['release_1']))).toBe(before);
  });

  it('a wrong token acknowledges nothing', async () => {
    const w = await world();
    const t = await tui(w, BINDING, BINDING, 'async');
    await release(w, t.inbox, BINDING, 'release_1');
    await t.bridge.read({ sessionID: SESSION });
    await t.bridge.read({ sessionID: SESSION, ackBatchToken: 'not-the-token' });
    expect(await acknowledged(w, ['release_1'])).toEqual([]);
  });

  it('a token returned through another authenticated binding, or with no credential, acknowledges nothing', async () => {
    for (const authenticated of [OTHER, null]) {
      const w = await world();
      const t = await tui(w, BINDING, authenticated, 'async');
      await release(w, t.inbox, BINDING, 'release_1');
      const token = tokenOf(await t.bridge.read({ sessionID: SESSION }));
      // The plugin's tool wrapper reports this refusal to the agent as `refused`.
      await expect(t.bridge.read({ sessionID: SESSION, ackBatchToken: token })).rejects.toMatchObject({ code: 'binding_not_held' });
      expect(await acknowledged(w, ['release_1'])).toEqual([]);
    }
  });

  it('a stale binding generation cannot acknowledge the current generation\'s batch', async () => {
    const w = await world();
    const t = await tui(w, BINDING, bindingFor(BINDING.bindingId, 1), 'async');
    await release(w, t.inbox, BINDING, 'release_1');
    const token = tokenOf(await t.bridge.read({ sessionID: SESSION }));
    await expect(t.bridge.read({ sessionID: SESSION, ackBatchToken: token })).rejects.toMatchObject({ code: 'binding_not_held' });
    expect(await acknowledged(w, ['release_1'])).toEqual([]);
  });

  it('reconnect: a restarted plugin process still acknowledges the retained token exactly once', async () => {
    const w = await world();
    const t = await tui(w, BINDING);
    await release(w, t.inbox, BINDING, 'release_1');
    const token = await deliverIdle(t);
    await t.restart();
    expect(await acknowledged(w, ['release_1'])).toEqual([]);

    await t.bridge.read({ sessionID: SESSION, ackBatchToken: token });
    expect(await acknowledged(w, ['release_1'])).toHaveLength(1);
  });
});
