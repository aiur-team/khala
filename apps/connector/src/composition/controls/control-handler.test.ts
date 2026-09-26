import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  type BindingId, type CommandId, type DeliveryLimits, type DeviceId, type EventId, type EventRef,
  type OwnerAuthority, type OwnerId, type ParticipantId, type PolicySetCommand, type RoomId, type SessionBinding,
  type UnverifiedReleasedJob, decodeDeliveryLimits,
} from '@khala/contracts/delivery/index';
import { encodeMessageContent } from '@khala/contracts/messaging/events';
import { precheck, queuedRecord } from '@khala/connector/dispatch/claim';
import type { DispatchLimits } from '@khala/connector/dispatch/types';
import { createConnectorDispatchStorage } from '@khala/connector/storage/dispatch';
import { type ConnectorStorage, openConnectorStorage } from '@khala/connector/storage/open';
import { sha256Digest } from '@khala/connector/storage/payloads';
import type { TrustState } from '@khala/policy/trust/index';
import { createReviewControlHandler } from '../review/control-handler';
import { type PolicyControlDependencies, type TrustStateStore, createPolicyControlHandler } from './control-handler';

const decodedLimits = decodeDeliveryLimits({ maxSelectionEvents: 20, maxPayloadBytes: 64 * 1024 });
if (!decodedLimits.ok) throw new Error('limits');
const limits: DeliveryLimits = decodedLimits.value;
const dispatchLimits: DispatchLimits = { maxJobsPerCausalRoot: 5, maxConcurrentJobs: 1, busy: 'queue' };

const roomId = 'room_controls' as RoomId;
const ownerId = 'owner_b' as OwnerId;
const bindingId = 'binding_b' as BindingId;
const agent = 'participant_agent_b' as ParticipantId;
const peer = 'participant_a' as ParticipantId;
const canary = 'canary-controls 5d1e';

const authority: OwnerAuthority = {
  ownerId,
  issuer: 'https://issuer.example.test',
  subject: 'subject-b',
  authenticatedAt: '2026-09-25T10:00:00Z',
  authorizationId: 'authz_b' as OwnerAuthority['authorizationId'],
};
const otherOwner: OwnerAuthority = { ...authority, ownerId: 'owner_c' as OwnerId, subject: 'subject-c' };

function binding(generation = 0): SessionBinding {
  return {
    v: 1, bindingId, ownerId, agentParticipantId: agent, deviceId: 'device_connector_b' as DeviceId,
    harness: 'codex', sessionId: `session_g${generation}`, generation,
  };
}

const content = encodeMessageContent({ v: 1, kind: 'text', body: canary });
const eventRef: EventRef = {
  v: 1, roomId, eventId: 'event_a' as EventId, authorParticipantId: peer, authorDeviceId: 'device_a' as DeviceId,
  contentDigest: sha256Digest(content),
};

function policyCommand(commandId: string, overrides: Partial<PolicySetCommand> = {}): PolicySetCommand {
  return {
    v: 1, commandId: commandId as CommandId, roomId, bindingId, peerParticipantId: peer,
    expectedPolicyVersion: 3, expectedBindingGeneration: 0, mode: 'review', paused: true,
    issuedAt: '2026-09-25T10:02:00Z', ...overrides,
  };
}

/** Serialized, non-durable reference store. Production injects a durable one. */
function memoryTrust(): TrustStateStore & { fail: boolean } {
  const states = new Map<BindingId, TrustState>();
  let tail = Promise.resolve();
  const store = {
    fail: false,
    async read(id: BindingId) {
      if (store.fail) throw new Error('trust store offline');
      return states.get(id) ?? null;
    },
    update<T>(id: BindingId, work: (current: TrustState | null) => Readonly<{ next: TrustState; result: T }>) {
      const run = tail.then(() => {
        if (store.fail) throw new Error('trust store offline');
        const { next, result } = work(states.get(id) ?? null);
        states.set(id, next);
        return result;
      });
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
  };
  return store;
}

const opened: ConnectorStorage[] = [];
const scratch: string[] = [];
const getuid = Object.getOwnPropertyDescriptor(process, 'getuid');
const getgid = Object.getOwnPropertyDescriptor(process, 'getgid');

beforeAll(() => {
  // The managed workspace has synthetic ancestor ownership; storage owns that proof.
  Object.defineProperty(process, 'getuid', { configurable: true, value: undefined });
  Object.defineProperty(process, 'getgid', { configurable: true, value: undefined });
});

afterAll(() => {
  if (getuid) Object.defineProperty(process, 'getuid', getuid);
  if (getgid) Object.defineProperty(process, 'getgid', getgid);
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map(storage => storage.close().catch(() => undefined)));
  for (const directory of scratch.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function seeded() {
  const parent = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'kha135-'));
  scratch.push(parent);
  const storage = await openConnectorStorage({ directory: path.join(parent, 'state'), mode: 'create', limits });
  opened.push(storage);
  await storage.ledger.transaction(tx => tx.putBinding(binding(0)));
  const dispatchStorage = createConnectorDispatchStorage(storage);
  expect(await dispatchStorage.applyEffectivePolicy({
    binding: binding(0),
    policy: {
      version: 3, armedAt: 3, paused: false, expiresAt: null,
      listening: { version: 1, requested: 'sync', effective: 'sync', evidenceRevision: 'evidence-1' },
    },
  })).toEqual({ kind: 'applied' });
  expect(await storage.persistPending({
    key: { roomId, eventId: eventRef.eventId, recipientBindingId: bindingId, recipientGeneration: 0 },
    event: eventRef, plaintext: content, receivedAt: '2026-09-25T09:59:00Z', streamId: 'stream_1',
  })).toMatchObject({ kind: 'inserted' });
  return { storage, dispatchStorage };
}

async function harness(overrides: Partial<PolicyControlDependencies> = {}) {
  const { storage, dispatchStorage } = await seeded();
  const trust = memoryTrust();
  const handler = createPolicyControlHandler({ dispatchStorage, trust, roomId, bindingId, ...overrides });
  const enforced = () => dispatchStorage.ledger.transact(tx => tx.policy(bindingId));
  return { storage, dispatchStorage, trust, handler, enforced };
}

describe('policy control handler', () => {
  it('makes a pause effective only through the dispatch ledger commit', async () => {
    const { handler, enforced } = await harness();

    expect(await handler.setPolicy(authority, policyCommand('pause-1'))).toEqual({
      ok: true,
      ack: {
        v: 1, commandId: 'pause-1', bindingId, generation: 0, requestedVersion: 4, effectiveVersion: 4,
        connectorState: 'effective', errorCode: null,
      },
    });
    // Pause is not a re-arm: approvals made at version 3 stay current once resumed.
    expect(await enforced()).toMatchObject({ version: 4, armedAt: 3, paused: true });

    const status = await handler.status(authority, { bindingId });
    expect(status).toMatchObject({
      ok: true,
      status: {
        bindingStatus: 'active', busy: false, requested: null, latestReceipt: null, capabilities: null,
        policy: { bindingId, generation: 0, effectiveVersion: 4, effectiveMode: 'review', paused: true },
      },
    });
  });

  it('holds approved work at the dispatcher while paused and releases it on resume', async () => {
    const { storage, dispatchStorage, handler } = await harness();
    const review = createReviewControlHandler({
      storage,
      dispatchStorage,
      releases: {
        enqueue: job => dispatchStorage.ledger.transact(tx => {
          tx.put(queuedRecord(job, tx.nextSeq()));
          return 'queued' as const;
        }),
      },
      room: { members: async () => [peer, agent] },
      limits,
      newReleaseId: () => 'release_1',
    });
    const approved = await review.approve(authority, {
      v: 1, commandId: 'approve-1', roomId, bindingId, expectedPolicyVersion: 3, expectedBindingGeneration: 0,
      selection: [eventRef], issuedAt: '2026-09-25T10:01:00Z',
    });
    expect(approved).toEqual({ ok: true, releaseIds: ['release_1'] });
    const check = () => dispatchStorage.ledger.transact(tx => {
      const result = precheck(tx, 'release_1' as UnverifiedReleasedJob['releaseId'], new Date('2026-09-25T10:03:00Z'), dispatchLimits);
      return { kind: result.kind, reason: tx.record('release_1' as UnverifiedReleasedJob['releaseId'])?.reason };
    });

    await handler.setPolicy(authority, policyCommand('pause-1'));
    expect(await check()).toEqual({ kind: 'held', reason: 'paused' });

    const resumed = await handler.setPolicy(authority, policyCommand('resume-1', { expectedPolicyVersion: 4, paused: false }));
    expect(resumed).toMatchObject({ ok: true, ack: { effectiveVersion: 5, connectorState: 'effective' } });
    expect(await check()).toMatchObject({ kind: 'proceed' });
    review.dispose();
  });

  it('refuses a wrong owner, a stale generation and a stale version before any policy write', async () => {
    const { handler, enforced } = await harness();

    expect(await handler.setPolicy(otherOwner, policyCommand('c-owner'))).toEqual({ ok: false, code: 'forbidden' });
    expect(await handler.status(otherOwner, { bindingId })).toEqual({ ok: false, code: 'forbidden' });
    expect(await handler.setPolicy(authority, policyCommand('c-gen', { expectedBindingGeneration: 1 })))
      .toMatchObject({ ok: true, ack: { connectorState: 'rejected', errorCode: 'stale_binding', effectiveVersion: 3 } });
    expect(await handler.setPolicy(authority, policyCommand('c-ver', { expectedPolicyVersion: 2 })))
      .toMatchObject({ ok: true, ack: { connectorState: 'rejected', errorCode: 'stale_policy', requestedVersion: null } });
    expect(await enforced()).toMatchObject({ version: 3, paused: false });
  });

  it('refuses another binding, a malformed body and authority smuggled in the body', async () => {
    const { handler } = await harness();
    expect(await handler.setPolicy(authority, policyCommand('c-other', { bindingId: 'binding_x' as BindingId })))
      .toEqual({ ok: false, code: 'forbidden' });
    expect(await handler.setPolicy(authority, { ...policyCommand('c-extra'), ownerId })).toEqual({ ok: false, code: 'forbidden' });
    expect(await handler.status(authority, { bindingId, ownerId })).toEqual({ ok: false, code: 'forbidden' });
  });

  it('never makes hosted auto effective', async () => {
    const { handler, enforced } = await harness();
    const result = await handler.setPolicy(authority, policyCommand('auto-1', { mode: 'auto', paused: false }));
    expect(result).toEqual({
      ok: true,
      ack: {
        v: 1, commandId: 'auto-1', bindingId, generation: 0, requestedVersion: null, effectiveVersion: 3,
        connectorState: 'rejected', errorCode: 'unavailable',
      },
    });
    expect(await enforced()).toMatchObject({ version: 3, armedAt: 3, paused: false });
  });

  it('lets exactly one of two tabs with the same expected version win', async () => {
    const { handler, enforced } = await harness();
    const [a, b] = await Promise.all([
      handler.setPolicy(authority, policyCommand('tab-a', { paused: true })),
      handler.setPolicy(authority, policyCommand('tab-b', { paused: false })),
    ]);
    const acks = [a, b].map(result => (result.ok ? result.ack : null));
    expect(acks.filter(ack => ack?.connectorState === 'effective')).toHaveLength(1);
    expect(acks.filter(ack => ack?.errorCode === 'stale_policy')).toHaveLength(1);
    const winner = acks.find(ack => ack?.connectorState === 'effective')!;
    expect(await enforced()).toMatchObject({ version: 4, paused: winner.commandId === 'tab-a' });
  });

  it('keeps an unknown ledger write pending and enforces the same command on retry', async () => {
    const { dispatchStorage, trust, handler, enforced } = await harness();
    let failing = true;
    const flaky = createPolicyControlHandler({
      dispatchStorage: {
        ledger: dispatchStorage.ledger,
        applyEffectivePolicy: input => (failing ? Promise.reject(new Error('disk')) : dispatchStorage.applyEffectivePolicy(input)),
      },
      trust, roomId, bindingId,
    });

    const first = await flaky.setPolicy(authority, policyCommand('pause-1'));
    expect(first).toMatchObject({
      ok: true, ack: { connectorState: 'pending', errorCode: 'outcome_unknown', requestedVersion: 4, effectiveVersion: null },
    });
    expect(await enforced()).toMatchObject({ version: 3, paused: false });
    // A newer command cannot skip the unenforced one; nothing is written for it.
    expect(await flaky.setPolicy(authority, policyCommand('resume-2', { paused: false }))).toMatchObject({
      ok: true, ack: { commandId: 'resume-2', connectorState: 'rejected', errorCode: 'unavailable', requestedVersion: null },
    });
    expect(await handler.status(authority, { bindingId })).toMatchObject({
      ok: true,
      status: {
        policy: { effectiveVersion: 3, paused: false },
        requested: { commandId: 'pause-1', version: 4, paused: true, connectorState: 'pending', errorCode: 'outcome_unknown' },
      },
    });

    failing = false;
    const retried = await flaky.setPolicy(authority, policyCommand('pause-1'));
    expect(retried).toMatchObject({ ok: true, ack: { commandId: 'pause-1', effectiveVersion: 4, connectorState: 'effective' } });
    expect(await enforced()).toMatchObject({ version: 4, paused: true });
    // The same identity again is a replay, never a second revision.
    expect(await flaky.setPolicy(authority, policyCommand('pause-1')))
      .toMatchObject({ ok: true, ack: { effectiveVersion: 4, connectorState: 'effective' } });
    expect(await flaky.setPolicy(authority, policyCommand('pause-1', { paused: false })))
      .toMatchObject({ ok: true, ack: { connectorState: 'rejected', errorCode: 'idempotency_conflict' } });
    expect(await enforced()).toMatchObject({ version: 4 });
  });

  it('enforces an accepted request left behind by a crash before serving new commands', async () => {
    const { dispatchStorage, trust, handler, enforced } = await harness();
    const crashed = createPolicyControlHandler({
      dispatchStorage: { ledger: dispatchStorage.ledger, applyEffectivePolicy: () => Promise.reject(new Error('crash')) },
      trust, roomId, bindingId,
    });
    await crashed.setPolicy(authority, policyCommand('pause-1'));
    expect(await enforced()).toMatchObject({ version: 3 });

    await handler.reconcile(bindingId);
    expect(await enforced()).toMatchObject({ version: 4, paused: true });
    expect(await handler.status(authority, { bindingId })).toMatchObject({
      ok: true, status: { requested: null, policy: { effectiveVersion: 4, paused: true } },
    });
  });

  it('answers outcome_unknown when trust state fails after the command may have been journalled', async () => {
    const { trust, handler, enforced } = await harness();
    trust.fail = true;
    expect(await handler.setPolicy(authority, policyCommand('pause-1'))).toMatchObject({
      ok: true, ack: { commandId: 'pause-1', connectorState: 'pending', errorCode: 'outcome_unknown', effectiveVersion: null },
    });
    expect(await handler.status(authority, { bindingId })).toEqual({ ok: false, code: 'unavailable' });
    expect(await enforced()).toMatchObject({ version: 3 });
  });

  it('starts a new generation from what the ledger enforces', async () => {
    const { storage, dispatchStorage, handler, enforced } = await harness();
    await handler.setPolicy(authority, policyCommand('pause-1'));

    await storage.ledger.transaction(tx => tx.putBinding(binding(1)));
    await dispatchStorage.applyEffectivePolicy({
      binding: binding(1),
      policy: {
        version: 5, armedAt: 5, paused: false, expiresAt: null,
        listening: { version: 1, requested: 'sync', effective: 'sync', evidenceRevision: 'evidence-1' },
      },
    });
    // The generation-0 command replayed after the rebind is stale, never a success.
    expect(await handler.setPolicy(authority, policyCommand('pause-1'))).toMatchObject({
      ok: true, ack: { connectorState: 'rejected', errorCode: 'stale_binding', generation: 1 },
    });
    expect(await handler.setPolicy(authority, policyCommand('pause-g1', { expectedBindingGeneration: 1, expectedPolicyVersion: 5 })))
      .toMatchObject({ ok: true, ack: { generation: 1, effectiveVersion: 6, connectorState: 'effective' } });
    expect(await enforced()).toMatchObject({ version: 6, paused: true });
  });

  it('answers a retry of an enforced command as effective after a newer one superseded it', async () => {
    const { handler, enforced } = await harness();
    await handler.setPolicy(authority, policyCommand('pause-1'));
    await handler.setPolicy(authority, policyCommand('resume-2', { expectedPolicyVersion: 4, paused: false }));
    expect(await handler.setPolicy(authority, policyCommand('pause-1'))).toMatchObject({
      ok: true, ack: { commandId: 'pause-1', effectiveVersion: 4, connectorState: 'effective', errorCode: null },
    });
    expect(await enforced()).toMatchObject({ version: 5, paused: false });
  });

  it('reports the command enforced when a concurrent command enforced it and moved the ledger on', async () => {
    const { dispatchStorage, trust, handler, enforced } = await harness();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    // The first write waits until another command has enforced it and committed a newer one.
    let held = true;
    const slow = createPolicyControlHandler({
      dispatchStorage: {
        ledger: dispatchStorage.ledger,
        applyEffectivePolicy: async input => {
          if (held) {
            held = false;
            await gate;
          }
          return dispatchStorage.applyEffectivePolicy(input);
        },
      },
      trust, roomId, bindingId,
    });
    const first = slow.setPolicy(authority, policyCommand('pause-1'));
    await new Promise(resolve => setTimeout(resolve, 10));
    // This command's settle enforces pause-1, then it commits version 5.
    expect(await handler.setPolicy(authority, policyCommand('resume-2', { expectedPolicyVersion: 4, paused: false })))
      .toMatchObject({ ok: true, ack: { effectiveVersion: 5, connectorState: 'effective' } });
    release();
    expect(await first).toMatchObject({ ok: true, ack: { commandId: 'pause-1', effectiveVersion: 4, connectorState: 'effective' } });
    expect(await enforced()).toMatchObject({ version: 5, paused: false });
  });

  it('starts again from the ledger when the trust store fell behind it', async () => {
    const { dispatchStorage, trust, handler, enforced } = await harness();
    await handler.setPolicy(authority, policyCommand('pause-1'));
    const stale = await trust.read(bindingId);
    await handler.setPolicy(authority, policyCommand('resume-2', { expectedPolicyVersion: 4, paused: false }));
    // A restored store at version 4 sees the ledger at version 5.
    await trust.update(bindingId, () => ({ next: stale!, result: undefined }));
    const restored = createPolicyControlHandler({ dispatchStorage, trust, roomId, bindingId });
    expect(await restored.setPolicy(authority, policyCommand('pause-3', { expectedPolicyVersion: 5 })))
      .toMatchObject({ ok: true, ack: { effectiveVersion: 6, connectorState: 'effective' } });
    expect(await enforced()).toMatchObject({ version: 6, paused: true });
  });

  it('stays unavailable for a generation the ledger has no policy for', async () => {
    const { storage, handler } = await harness();
    await storage.ledger.transaction(tx => tx.putBinding(binding(1)));
    expect(await handler.setPolicy(authority, policyCommand('pause-g1', { expectedBindingGeneration: 1 }))).toMatchObject({
      ok: true, ack: { connectorState: 'rejected', errorCode: 'unavailable', generation: 1 },
    });
    expect(await handler.status(authority, { bindingId })).toMatchObject({
      ok: true, status: { policy: { generation: 1, effectiveVersion: null, effectiveMode: null, paused: null } },
    });
  });

  it('carries no pending message content in the status', async () => {
    const { handler } = await harness();
    const status = await handler.status(authority, { bindingId });
    expect(status).toMatchObject({ ok: true, status: { busy: false, latestReceipt: null } });
    expect(JSON.stringify(status)).not.toContain(canary);
  });
});
