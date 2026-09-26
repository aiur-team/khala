// Composition proof of the review seam on real parts: the durable KHA-115 ledger,
// KHA-119 release policy, this ticket's handler and registration, and the KHA-121
// dispatcher. Only the transport and harness are scripted: the transport stands in
// for the protected human channel, and the harness records exactly what would have
// entered the model's session.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  type ApprovalCommand, type BindingId, type CommandId, type DeliveryLimits, type DeliveryReceipt, type DeviceId,
  type EventId, type EventRef, type HarnessCapabilities, type HarnessPort, type OwnerAuthority, type OwnerId,
  type ParticipantId, type ReleasedJob, type RoomId, type SessionBinding, decodeDeliveryLimits,
} from '@khala/contracts/delivery/index';
import { encodeMessageContent } from '@khala/contracts/messaging/events';
import { createDispatcher } from '@khala/connector/dispatch/run';
import type { Dispatcher } from '@khala/connector/dispatch/types';
import { createConnectorDispatchStorage } from '@khala/connector/storage/dispatch';
import { type ConnectorStorage, openConnectorStorage } from '@khala/connector/storage/open';
import { sha256Digest } from '@khala/connector/storage/payloads';
import type { ConnectorCapabilityContext } from '../../runtime/capabilities';
import type { ReviewControlHandler } from './control-handler';
import { registerReview } from './register';

const decodedLimits = decodeDeliveryLimits({ maxSelectionEvents: 20, maxPayloadBytes: 64 * 1024 });
if (!decodedLimits.ok) throw new Error('limits');
const limits: DeliveryLimits = decodedLimits.value;

const roomId = 'room_review' as RoomId;
const ownerId = 'owner_b' as OwnerId;
const bindingId = 'binding_b' as BindingId;
const agent = 'participant_agent_b' as ParticipantId;
const author = 'participant_a' as ParticipantId;
const EVIDENCE = 'evidence-1';
const canaryA = 'canary-A withheld 51d0';
const canaryB = 'canary-B approved c7aa';

const binding: SessionBinding = {
  v: 1, bindingId, ownerId, agentParticipantId: agent, deviceId: 'device_connector_b' as DeviceId,
  harness: 'codex', sessionId: 'existing-session-1', generation: 0,
};
const authority: OwnerAuthority = {
  ownerId, issuer: 'https://issuer.example.test', subject: 'subject-b', authenticatedAt: '2026-09-25T10:00:00Z',
  authorizationId: 'authz_b' as OwnerAuthority['authorizationId'],
};

const content = (body: string) => encodeMessageContent({ v: 1, kind: 'text', body });
const ref = (eventId: string, body: string): EventRef => ({
  v: 1, roomId, eventId: eventId as EventId, authorParticipantId: author, authorDeviceId: 'device_a' as DeviceId,
  contentDigest: sha256Digest(content(body)),
});
const refA = ref('event_a', canaryA);
const refB = ref('event_b', canaryB);
const approveB = (commandId = 'approve-b-7'): ApprovalCommand => ({
  v: 1, commandId: commandId as CommandId, roomId, bindingId, expectedPolicyVersion: 3, expectedBindingGeneration: 0,
  selection: [refB], issuedAt: '2026-09-25T10:01:00Z',
});

function capabilities(): HarnessCapabilities {
  const mode = (name: string) => ({
    status: 'proven', route: `test-codex-${name}`, testedVersion: '0.154.0', evidenceRef: `docs/evidence/codex-${name}.md`,
    evidenceRevision: EVIDENCE, reason: null,
  });
  return {
    v: 3, harness: 'codex', version: '0.154.0', adapterVersion: 'test-adapter', support: 'tested',
    existingSession: 'khala_hosted_resume', immediateNotification: 'khala_hosted_idle', busy: 'queue',
    receiptEvidence: ['harness_queued', 'completed', 'outcome_unknown', 'failed'], reconcileByReleaseId: 'while_queued',
    limits, evidenceRef: 'docs/evidence/codex.md', modes: { steer: mode('steer'), sync: mode('sync'), async: mode('async') },
    acknowledgement: 'batch_token_next_call',
  } as HarnessCapabilities;
}

/** Records every byte that reaches the session. `crashAfterWrite` loses the acknowledgement. */
class SessionHarness implements HarnessPort {
  readonly submitted: string[] = [];
  crashAfterWrite = false;
  async inspect() { return capabilities(); }
  async notify() {}
  async submit({ job, payload }: Readonly<{ job: ReleasedJob; payload: Uint8Array }>): Promise<DeliveryReceipt> {
    this.submitted.push(new TextDecoder().decode(payload));
    if (this.crashAfterWrite) throw new Error('connection lost after write');
    return {
      v: 1, receiptId: `receipt-${job.releaseId}-queued` as DeliveryReceipt['receiptId'], releaseId: job.releaseId,
      bindingId: job.binding.bindingId, generation: job.binding.generation, kind: 'harness_queued',
      observedAt: '2026-09-25T10:02:00Z', source: 'harness', evidenceRef: `codex:${job.releaseId}`, errorCode: null,
    };
  }
  async reconcile() { return null; }
  async close() {}
}

const opened: ConnectorStorage[] = [];
const dispatchers: Dispatcher[] = [];
const scratch: string[] = [];
const getuid = Object.getOwnPropertyDescriptor(process, 'getuid');
const getgid = Object.getOwnPropertyDescriptor(process, 'getgid');

beforeAll(() => {
  Object.defineProperty(process, 'getuid', { configurable: true, value: undefined });
  Object.defineProperty(process, 'getgid', { configurable: true, value: undefined });
});
afterAll(() => {
  if (getuid) Object.defineProperty(process, 'getuid', getuid);
  if (getgid) Object.defineProperty(process, 'getgid', getgid);
});
afterEach(async () => {
  await Promise.all(dispatchers.splice(0).map(dispatcher => dispatcher.stop()));
  await Promise.all(opened.splice(0).map(storage => storage.close().catch(() => undefined)));
  for (const directory of scratch.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function openStore(state: string, mode: 'create' | 'existing') {
  const storage = await openConnectorStorage({ directory: state, mode, limits });
  opened.push(storage);
  return storage;
}

async function seed() {
  const parent = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'kha134-flow-'));
  scratch.push(parent);
  const state = path.join(parent, 'state');
  const storage = await openStore(state, 'create');
  await storage.ledger.transaction(tx => tx.putBinding(binding));
  await createConnectorDispatchStorage(storage).applyEffectivePolicy({
    binding,
    policy: {
      version: 3, armedAt: 3, paused: false, expiresAt: null,
      listening: { version: 1, requested: 'sync', effective: 'sync', evidenceRevision: EVIDENCE },
    },
  });
  for (const [event, body] of [[refA, canaryA], [refB, canaryB]] as const) {
    await storage.persistPending({
      key: { roomId, eventId: event.eventId, recipientBindingId: bindingId, recipientGeneration: 0 },
      event, plaintext: content(body), receivedAt: '2026-09-25T09:59:00Z', streamId: 'stream_1',
    });
  }
  return { state, storage };
}

/** One connector process: dispatcher, review capability and a protected-transport stand-in. */
async function connector(storage: ConnectorStorage, harness: SessionHarness, options: { dropHandoff?: boolean } = {}) {
  const dispatchStorage = createConnectorDispatchStorage(storage);
  let ids = 0;
  const dispatcher = createDispatcher({
    ledger: dispatchStorage.ledger,
    limits: { maxJobsPerCausalRoot: 10, maxConcurrentJobs: 10, busy: 'queue' },
    harness,
    boundary: { await: async ({ job }) => ({ binding: job.binding, capabilities: capabilities() }) },
    approvals: dispatchStorage.approvals,
    payloads: dispatchStorage.payloads,
    digest: async bytes => sha256Digest(bytes),
    clock: { now: () => new Date('2026-09-25T10:01:30Z') },
    newId: kind => `${kind}-${(ids += 1)}`,
    workerId: 'worker-1',
  });
  dispatchers.push(dispatcher);
  for (const releaseId of await dispatchStorage.reconciliationReleaseIds()) await dispatcher.reconcile(releaseId);

  let served: ReviewControlHandler | null = null;
  let releaseCounter = 0;
  const context: ConnectorCapabilityContext = {
    binding,
    ledger: { runtimeLedgerPort: true },
    dispatcher: { reconcilePending: async () => undefined, setEnabled: () => undefined, stop: async () => undefined },
    clock: () => 0,
    prerequisiteChanged: () => undefined,
  };
  const capability = registerReview({
    ...context,
    dependencies: {
      protectedTransport: {
        capability: 'review',
        serve(handler) {
          served = handler;
          return () => { served = null; };
        },
      },
      control: {
        storage,
        dispatchStorage,
        releases: options.dropHandoff
          ? { enqueue: async () => { throw new Error('process died before handoff'); } }
          : dispatcher,
        room: { members: async () => [author, agent] },
        limits,
        newReleaseId: () => `release_${(releaseCounter += 1)}`,
      },
    },
  });
  await capability.start();
  return {
    capability,
    dispatcher,
    /** The authenticated human request path; authority comes from the session, not the body. */
    approve: (body: unknown) => {
      if (served === null) throw new Error('review transport is not serving');
      return served.approve(authority, body);
    },
    preview: (body: unknown) => {
      if (served === null) throw new Error('review transport is not serving');
      return served.preview(authority, body);
    },
  };
}

describe('review delivery composition', () => {
  it('delivers only approved B to the existing session while A stays withheld and reviewable', async () => {
    const { storage } = await seed();
    const harness = new SessionHarness();
    const process1 = await connector(storage, harness);

    const result = await process1.approve(approveB());
    await process1.dispatcher.idle();

    expect(result).toEqual({ ok: true, releaseIds: ['release_1'] });
    expect(harness.submitted).toHaveLength(1);
    expect(harness.submitted[0]).toContain(canaryB);
    expect(harness.submitted[0]).toContain(author);
    expect(harness.submitted.join('\n')).not.toContain(canaryA);
    const preview = await process1.preview({ bindingId, candidates: [refA], releaseIds: [] });
    expect(preview.ok && preview.preview.pending).toEqual([refA]);
  });

  it('a duplicate browser command and a restart never deliver B twice or leak A', async () => {
    const { storage, state } = await seed();
    const harness = new SessionHarness();
    const first = await connector(storage, harness);
    await first.approve(approveB());
    await first.approve(approveB());
    await first.dispatcher.idle();
    await first.capability.stop();
    await first.dispatcher.stop();
    await storage.close();

    const reopened = await openStore(state, 'existing');
    const second = await connector(reopened, harness);
    expect(await second.approve(approveB())).toEqual({ ok: true, releaseIds: ['release_1'] });
    await second.dispatcher.idle();

    expect(harness.submitted).toHaveLength(1);
    expect(harness.submitted.join('\n')).not.toContain(canaryA);
  });

  it('resumes a release committed before the dispatcher handoff, once, by its durable identity', async () => {
    const { storage, state } = await seed();
    const harness = new SessionHarness();
    const crashed = await connector(storage, harness, { dropHandoff: true });
    expect(await crashed.approve(approveB())).toEqual({ ok: true, releaseIds: ['release_1'] });
    expect(harness.submitted).toEqual([]);
    await crashed.capability.stop();
    await crashed.dispatcher.stop();
    await storage.close();

    const restarted = await connector(await openStore(state, 'existing'), harness);
    await restarted.dispatcher.idle();

    expect(harness.submitted).toHaveLength(1);
    expect(harness.submitted[0]).toContain(canaryB);
  });

  it('a crash after the harness write restores outcome_unknown and never submits again', async () => {
    const { storage, state } = await seed();
    const harness = new SessionHarness();
    harness.crashAfterWrite = true;
    const first = await connector(storage, harness);
    await first.approve(approveB());
    await first.dispatcher.idle();
    expect(harness.submitted).toHaveLength(1);
    await first.dispatcher.stop();
    await storage.close();

    harness.crashAfterWrite = false;
    const reopened = await openStore(state, 'existing');
    const second = await connector(reopened, harness);
    await second.dispatcher.idle();
    expect(await second.approve(approveB())).toEqual({ ok: true, releaseIds: ['release_1'] });
    await second.dispatcher.idle();

    expect(harness.submitted).toHaveLength(1);
    const state2 = await createConnectorDispatchStorage(reopened).ledger.transact(tx => tx.record('release_1' as never));
    expect(state2?.state).toBe('outcome_unknown');
  });
});
