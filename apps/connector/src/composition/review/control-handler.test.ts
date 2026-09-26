import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type ApprovalCommand, type BindingId, type CommandId, type DeliveryLimits, type DeviceId, type EventId,
  type EventRef, type OwnerAuthority, type OwnerId, type ParticipantId, type ReceiptId, type ReleaseId,
  type RoomId, type SessionBinding, type UnverifiedReleasedJob, decodeDeliveryLimits,
} from '@khala/contracts/delivery/index';
import { encodeMessageContent } from '@khala/contracts/messaging/events';
import type { EnqueueResult } from '@khala/connector/dispatch/types';
import { createConnectorDispatchStorage } from '@khala/connector/storage/dispatch';
import { type ConnectorStorage, openConnectorStorage } from '@khala/connector/storage/open';
import { sha256Digest } from '@khala/connector/storage/payloads';
import { createReviewControlHandler, type ReviewControlDependencies } from './control-handler';

const decodedLimits = decodeDeliveryLimits({ maxSelectionEvents: 20, maxPayloadBytes: 64 * 1024 });
if (!decodedLimits.ok) throw new Error('limits');
const limits: DeliveryLimits = decodedLimits.value;

const roomId = 'room_review' as RoomId;
const ownerId = 'owner_b' as OwnerId;
const bindingId = 'binding_b' as BindingId;
const agent = 'participant_agent_b' as ParticipantId;
const author = 'participant_a' as ParticipantId;
const canaryA = 'canary-A withheld 7f3e';
const canaryB = 'canary-B approved 91c2';

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

function content(body: string): Uint8Array {
  return encodeMessageContent({ v: 1, kind: 'text', body });
}

function ref(eventId: string, body: string): EventRef {
  return {
    v: 1, roomId, eventId: eventId as EventId, authorParticipantId: author, authorDeviceId: 'device_a' as DeviceId,
    contentDigest: sha256Digest(content(body)),
  };
}

const refA = ref('event_a', canaryA);
const refB = ref('event_b', canaryB);

function command(commandId: string, selection: readonly EventRef[], overrides: Partial<ApprovalCommand> = {}) {
  return {
    v: 1, commandId: commandId as CommandId, roomId, bindingId, expectedPolicyVersion: 3,
    expectedBindingGeneration: 0, selection, issuedAt: '2026-09-25T10:01:00Z', ...overrides,
  } satisfies ApprovalCommand;
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
  const parent = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'kha134-'));
  scratch.push(parent);
  const state = path.join(parent, 'state');
  const storage = await openConnectorStorage({ directory: state, mode: 'create', limits });
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
  for (const [event, body] of [[refA, canaryA], [refB, canaryB]] as const) {
    expect(await storage.persistPending({
      key: { roomId, eventId: event.eventId, recipientBindingId: bindingId, recipientGeneration: 0 },
      event, plaintext: content(body), receivedAt: '2026-09-25T09:59:00Z', streamId: 'stream_1',
    })).toMatchObject({ kind: 'inserted' });
  }
  return { state, storage, dispatchStorage };
}

function sink(fail = 0) {
  const jobs: UnverifiedReleasedJob[] = [];
  let failures = fail;
  return {
    jobs,
    async enqueue(job: UnverifiedReleasedJob): Promise<EnqueueResult> {
      if (failures > 0) {
        failures -= 1;
        throw new Error('dispatcher offline');
      }
      const duplicate = jobs.some(existing => existing.releaseId === job.releaseId);
      if (!duplicate) jobs.push(job);
      return duplicate ? 'duplicate' : 'queued';
    },
  };
}

function handlerFor(
  storage: ConnectorStorage,
  releases: ReturnType<typeof sink>,
  overrides: Partial<ReviewControlDependencies> = {},
) {
  let next = 0;
  return createReviewControlHandler({
    storage,
    dispatchStorage: createConnectorDispatchStorage(storage),
    releases,
    room: { members: async () => [author, agent] },
    limits,
    newReleaseId: () => `release_${(next += 1)}`,
    ...overrides,
  });
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe('review control handler', () => {
  it('releases only the selected event and keeps the unselected one out of the model payload', async () => {
    const { storage } = await seeded();
    const releases = sink();
    const handler = handlerFor(storage, releases);

    const result = await handler.approve(authority, command('approve-b-7', [refB]));

    expect(result).toEqual({ ok: true, releaseIds: ['release_1'] });
    expect(releases.jobs).toHaveLength(1);
    const job = releases.jobs[0]!;
    expect(job.events).toEqual([refB]);
    expect(job.binding).toEqual(binding(0));
    const payload = decodeText(await storage.readReleasedPayload(job.payloadRef));
    expect(payload).toContain(canaryB);
    expect(payload).not.toContain(canaryA);
    expect(payload).toContain(author);

    // A stays reviewable for its owner and was never journalled or enqueued.
    const preview = await handler.preview(authority, { bindingId, candidates: [refA, refB], releaseIds: ['release_1'] });
    expect(preview).toMatchObject({ ok: true, preview: { bindingGeneration: 0, policyVersion: 3 } });
    expect(preview.ok && preview.preview.pending).toContainEqual(refA);
    expect(JSON.stringify(preview)).not.toContain(canaryA);
  });

  it.each([
    ['wrong owner', otherOwner, command('c-owner', [refB]), 'forbidden'],
    ['stale generation', authority, command('c-gen', [refB], { expectedBindingGeneration: 1 }), 'stale_binding'],
    ['stale policy', authority, command('c-policy', [refB], { expectedPolicyVersion: 2 }), 'stale_policy'],
    ['edited content', authority, command('c-edit', [ref('event_b', 'edited body')]), 'stale_content'],
    ['duplicate selection', authority, command('c-dup', [refB, refB]), 'forbidden'],
    ['unknown binding', authority, command('c-bind', [refB], { bindingId: 'binding_x' as BindingId }), 'stale_binding'],
  ] as const)('refuses %s before any release reaches the dispatcher', async (_name, who, input, code) => {
    const { storage } = await seeded();
    const releases = sink();

    expect(await handlerFor(storage, releases).approve(who, input)).toEqual({ ok: false, code });
    expect(releases.jobs).toEqual([]);
    const report = await storage.ledger.transaction(tx => tx.readCommand(who.ownerId, input.commandId));
    expect(report).toBeNull();
  });

  it('refuses a scoped handler command for another binding and authority fields smuggled in the body', async () => {
    const { storage } = await seeded();
    const releases = sink();
    const handler = handlerFor(storage, releases, { bindingId: 'binding_other' as BindingId });

    expect(await handler.approve(authority, command('c-scope', [refB]))).toEqual({ ok: false, code: 'forbidden' });
    const unscoped = handlerFor(storage, releases);
    expect(await unscoped.approve(otherOwner, { ...command('c-forge', [refB]), ownerId, human: true }))
      .toEqual({ ok: false, code: 'forbidden' });
    expect(releases.jobs).toEqual([]);
  });

  it('replays the same command and refuses a changed payload under the same command ID', async () => {
    const { storage } = await seeded();
    const releases = sink();
    const handler = handlerFor(storage, releases);

    const first = await handler.approve(authority, command('approve-b-7', [refB]));
    const retry = await handler.approve(authority, command('approve-b-7', [refB]));
    const changed = await handler.approve(authority, command('approve-b-7', [refA]));

    expect(first).toEqual({ ok: true, releaseIds: ['release_1'] });
    expect(retry).toEqual(first);
    expect(changed).toEqual({ ok: false, code: 'idempotency_conflict' });
    expect(releases.jobs.map(job => job.releaseId)).toEqual(['release_1']);
  });

  it('a second command for an already released event is refused', async () => {
    const { storage } = await seeded();
    const releases = sink();
    const handler = handlerFor(storage, releases);

    await handler.approve(authority, command('approve-b-7', [refB]));
    expect(await handler.approve(authority, command('approve-b-8', [refB])))
      .toEqual({ ok: false, code: 'stale_content' });
    expect(releases.jobs).toHaveLength(1);
  });

  it('resumes a committed release after the dispatcher handoff was lost, exactly once', async () => {
    const { storage, state } = await seeded();
    const offline = sink(1);
    const result = await handlerFor(storage, offline).approve(authority, command('approve-b-7', [refB]));
    expect(result).toEqual({ ok: true, releaseIds: ['release_1'] });
    expect(offline.jobs).toEqual([]);

    // Restart: same ledger, a fresh process-local dispatcher intake.
    await storage.close();
    const reopened = await openConnectorStorage({ directory: state, mode: 'existing', limits });
    opened.push(reopened);
    const restarted = sink();
    const handler = handlerFor(reopened, restarted);
    await handler.resumeReleases(bindingId);
    await handler.resumeReleases(bindingId);

    expect(restarted.jobs.map(job => job.releaseId)).toEqual(['release_1']);
    expect(restarted.jobs[0]!.events).toEqual([refB]);
  });

  it('reports an ambiguous commit as outcome_unknown and resolves the retry from the journal', async () => {
    const { storage } = await seeded();
    const releases = sink();
    const real = storage.ledger.transaction.bind(storage.ledger);
    let lose = true;
    const flaky = {
      ...storage,
      ledger: {
        transaction: async <T>(run: Parameters<typeof real<T>>[0]): Promise<T> => {
          let wrote = false;
          const value = await real(tx => run(new Proxy(tx, {
            get(target, key, receiver) {
              if (key === 'putRelease') wrote = true;
              return Reflect.get(target, key, receiver);
            },
          })));
          // The commit landed, but its answer is lost on the way back.
          if (wrote && lose) {
            lose = false;
            throw new Error('commit answer lost');
          }
          return value;
        },
      },
    } as ConnectorStorage;
    const handler = handlerFor(flaky, releases, { dispatchStorage: createConnectorDispatchStorage(storage) });

    const first = await handler.approve(authority, command('approve-b-7', [refB]));
    expect(first).toEqual({ ok: false, code: 'outcome_unknown', operationId: 'approve-b-7' });
    expect(releases.jobs).toEqual([]);

    const retry = await handler.approve(authority, command('approve-b-7', [refB]));
    expect(retry).toEqual({ ok: true, releaseIds: ['release_1'] });
    expect(releases.jobs.map(job => job.releaseId)).toEqual(['release_1']);
  });

  it('hands an accepted release over again without waiting for a restart', async () => {
    const { storage } = await seeded();
    const flaky = sink(1);
    const errors: string[] = [];
    const handler = handlerFor(storage, flaky, { resumeDelayMs: 5, onError: code => errors.push(code) });

    expect(await handler.approve(authority, command('approve-b-7', [refB]))).toEqual({ ok: true, releaseIds: ['release_1'] });
    expect(flaky.jobs).toEqual([]);
    await vi.waitFor(() => expect(flaky.jobs.map(job => job.releaseId)).toEqual(['release_1']));
    expect(errors).toEqual(['enqueue_failed']);
    handler.dispose();
  });

  it('reports a dispatcher conflict instead of treating it as delivered', async () => {
    const { storage } = await seeded();
    const errors: string[] = [];
    const conflicting = { jobs: [] as UnverifiedReleasedJob[], enqueue: async (): Promise<EnqueueResult> => 'conflict' };
    const handler = handlerFor(storage, conflicting as ReturnType<typeof sink>, { onError: code => errors.push(code) });

    expect(await handler.approve(authority, command('approve-b-7', [refB]))).toMatchObject({ ok: true });
    expect(errors).toEqual(['enqueue_conflict']);
  });

  it('never answers a definite refusal when a committed command cannot be read back', async () => {
    const { storage } = await seeded();
    await handlerFor(storage, sink()).approve(authority, command('approve-b-7', [refB]));
    const real = storage.ledger.transaction.bind(storage.ledger);
    const unreadable = {
      ...storage,
      ledger: {
        transaction: async <T>(run: Parameters<typeof real<T>>[0]): Promise<T> => {
          let reads = false;
          const value = await real(tx => run(new Proxy(tx, {
            get(target, key, receiver) {
              if (key === 'readCommand') reads = true;
              return Reflect.get(target, key, receiver);
            },
          })));
          if (reads) throw new Error('SQLITE_BUSY');
          return value;
        },
      },
    } as ConnectorStorage;
    const handler = handlerFor(unreadable, sink(), { dispatchStorage: createConnectorDispatchStorage(storage) });

    expect(await handler.approve(authority, command('approve-b-7', [refB])))
      .toEqual({ ok: false, code: 'outcome_unknown', operationId: 'approve-b-7' });
  });

  it('replays a journalled command while the dispatch ledger and membership are down', async () => {
    const { storage } = await seeded();
    await handlerFor(storage, sink()).approve(authority, command('approve-b-7', [refB]));
    const down = handlerFor(storage, sink(), {
      dispatchStorage: { ledger: { transact: async () => { throw new Error('down'); } } },
      room: { members: async () => { throw new Error('down'); } },
    });

    expect(await down.approve(authority, command('approve-b-7', [refB]))).toEqual({ ok: true, releaseIds: ['release_1'] });
  });

  it('keeps membership and missing policy explicit instead of inventing success', async () => {
    const { storage } = await seeded();
    const releases = sink();
    const noRoom = handlerFor(storage, releases, { room: { members: async () => null } });
    expect(await noRoom.approve(authority, command('c-room', [refB]))).toEqual({ ok: false, code: 'unavailable' });
    const agentLeft = handlerFor(storage, releases, { room: { members: async () => [author] } });
    expect(await agentLeft.approve(authority, command('c-left', [refB]))).toEqual({ ok: false, code: 'forbidden' });
    expect(releases.jobs).toEqual([]);
  });

  it('refuses every approval and preview once the binding is revoked', async () => {
    const { storage } = await seeded();
    const releases = sink();
    await storage.ledger.transaction(tx => tx.putRevocation({
      targetKind: 'binding', targetId: bindingId, generation: 0, operationId: 'revoke-1', revokedAt: '2026-09-25T10:00:30Z',
    }));
    const handler = handlerFor(storage, releases);

    expect(await handler.approve(authority, command('c-revoked', [refB]))).toEqual({ ok: false, code: 'forbidden' });
    expect(await handler.preview(authority, { bindingId, candidates: [refB], releaseIds: [] }))
      .toEqual({ ok: false, code: 'revoked' });
    expect(releases.jobs).toEqual([]);
  });
});

describe('review preview access', () => {
  it('answers another owner exactly like an unknown binding and never lists pending refs', async () => {
    const { storage } = await seeded();
    const handler = handlerFor(storage, sink());

    expect(await handler.preview(otherOwner, { bindingId, candidates: [refA], releaseIds: [] }))
      .toEqual({ ok: false, code: 'forbidden' });
    expect(await handler.preview(authority, { bindingId: 'binding_x', candidates: [refA], releaseIds: [] }))
      .toEqual({ ok: false, code: 'forbidden' });
  });

  it('refuses unknown request fields such as a claimed owner', async () => {
    const { storage } = await seeded();
    const handler = handlerFor(storage, sink());

    expect(await handler.preview(authority, { bindingId, candidates: [], releaseIds: [], ownerId }))
      .toEqual({ ok: false, code: 'forbidden' });
  });

  it('matches candidates byte for byte, so an edited version is not reviewable', async () => {
    const { storage } = await seeded();
    const handler = handlerFor(storage, sink());
    const edited = ref('event_a', 'edited A');

    const outcome = await handler.preview(authority, { bindingId, candidates: [edited, refB], releaseIds: [] });

    expect(outcome.ok && outcome.preview.pending).toEqual([refB]);
  });

  it('returns only correlated receipts for the owner\'s own releases', async () => {
    const { storage } = await seeded();
    const releases = sink();
    const handler = handlerFor(storage, releases);
    await handler.approve(authority, command('approve-b-7', [refB]));
    const releaseId = 'release_1' as ReleaseId;
    const written = {
      v: 1 as const, receiptId: 'receipt_1' as ReceiptId, releaseId, bindingId, generation: 0,
      kind: 'transport_written' as const, observedAt: '2026-09-25T10:02:00Z', source: 'connector' as const,
      evidenceRef: null, errorCode: null,
    };
    await storage.ledger.transaction(tx => tx.appendReceipt({ receipt: written }));
    await storage.ledger.transaction(tx => tx.appendReceipt({
      receipt: { ...written, receiptId: 'receipt_2' as ReceiptId, generation: 5 },
    }));

    const mine = await handler.preview(authority, { bindingId, candidates: [], releaseIds: [releaseId, 'release_x'] });
    expect(mine.ok && mine.preview.receipts).toEqual([written]);
  });
});
