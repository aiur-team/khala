import fs from 'node:fs';
import path from 'node:path';
import type {
  AuthorizationId,
  CommandId,
  DeliveryLimits,
  HarnessCapabilities,
  ListeningModeCommand,
  OwnerAuthority,
  SessionBinding,
} from '@khala/contracts/delivery/index';
import {
  decodeContentLimits,
  encodeMessageContent,
  type AuthPrincipal,
  type DeviceId,
  type DevicePort,
  type MessageContent,
  type OwnerId,
  type ParticipantId,
  type ParticipantView,
} from '@khala/contracts/messaging/index';
import {
  startSubscription,
  type CursorStore,
  type EventIngestionPort,
  type Scheduler,
} from '@khala/connector/subscription/index';
import { createChannelService, createMemoryChannelJournal } from '@khala/messaging/channels/index';
import { createListeningModeService } from '@khala/policy/listening-mode/store';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteListeningModeRepository } from '../../listening-mode-store/sqlite';
import { createChannelStore, type ChannelStore } from '../../store/channel-store';
import { admitWithSharedHistory } from '../../store/fixtures/admission';
import { openChannelStore, type InternalStoreHandle } from '../../store/open';
import { createLocalChannelSubstrate } from './channel-substrate';
import { createLocalListeningModeStore } from './listening-mode-store';
import { createLocalSubscriptionSource } from './subscription-source';

const roots: string[] = [];
const handles: InternalStoreHandle[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const alice: ParticipantView = {
  participantId: 'participant-alice' as ParticipantId,
  ownerId: 'owner-alice' as OwnerId,
  kind: 'human',
  displayName: 'Alice',
  deviceIds: ['device-alice' as DeviceId],
};
const bob: ParticipantView = {
  participantId: 'participant-bob' as ParticipantId,
  ownerId: 'owner-bob' as OwnerId,
  kind: 'agent',
  displayName: 'Bob',
  deviceIds: ['device-bob' as DeviceId],
};
const binding: SessionBinding = {
  v: 1,
  bindingId: 'binding-bob' as SessionBinding['bindingId'],
  ownerId: bob.ownerId as SessionBinding['ownerId'],
  agentParticipantId: bob.participantId as SessionBinding['agentParticipantId'],
  deviceId: bob.deviceIds[0] as SessionBinding['deviceId'],
  harness: 'codex',
  sessionId: 'session-bob',
  generation: 4,
};
const limitsResult = decodeContentLimits({
  maxBodyBytes: 4_096,
  maxDisplayNameBytes: 128,
  maxRoomTitleBytes: 128,
});
if (!limitsResult.ok) throw new Error('test content limits must decode');
const limits = limitsResult.value;
const text = (body: string): MessageContent => ({ v: 1, kind: 'text', body });

function principal(participant: ParticipantView): AuthPrincipal {
  return {
    v: 1,
    ownerId: participant.ownerId,
    providerIssuer: 'https://issuer.example',
    providerSubject: `subject-${participant.ownerId}`,
    verifiedEmail: `${participant.displayName.toLowerCase()}@example.com`,
    sessionExpiresAt: '2027-09-24T00:00:00.000Z',
  };
}

function device(participant: ParticipantView): DevicePort {
  const view = { deviceId: participant.deviceIds[0]!, state: 'ready' as const, generation: 1, reason: null };
  return {
    async ensureReady() { return { kind: 'ok', value: view }; },
    current: () => view,
    observe: () => () => {},
    async stop() {},
  };
}

function ids(...values: readonly string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `unexpected-id-${index}`;
}

function channelService(store: ChannelStore, actor: ParticipantView, generatedIds: readonly string[]) {
  let now = Date.parse('2026-09-24T20:00:00.000Z');
  return createChannelService({
    principal: principal(actor),
    actor,
    device: device(actor),
    substrate: createLocalChannelSubstrate({
      store,
      ownerId: actor.ownerId,
      participant: actor,
      deviceId: actor.deviceIds[0]!,
      generation: 1,
      newId: ids(...generatedIds),
      clock: () => now++,
    }),
    journal: createMemoryChannelJournal(),
    limits,
    newId: ids('service-id-1', 'service-id-2'),
    clock: () => now++,
  });
}

function registerIdentities(store: ChannelStore): void {
  for (const participant of [alice, bob]) {
    expect(store.registerParticipant(participant)).toMatchObject({ kind: 'done' });
    expect(store.registerDevice({ deviceId: participant.deviceIds[0]!, participantId: participant.participantId }))
      .toMatchObject({ kind: 'done' });
  }
  expect(store.registerBinding(binding)).toMatchObject({ kind: 'done' });
}

function open(directory: string, mode: 'create' | 'existing') {
  const handle = openChannelStore({ directory, mode });
  handles.push(handle);
  return { handle, store: createChannelStore(handle) };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('integration condition was not reached');
}

function capabilities(): HarnessCapabilities {
  const support = (route: string) => ({
    status: 'proven' as const,
    route,
    testedVersion: '1.0.0',
    evidenceRef: 'docs/evidence.md',
    evidenceRevision: 'evidence-1',
    reason: null,
  });
  return {
    v: 3,
    harness: 'codex',
    version: '1.0.0',
    adapterVersion: 'adapter-1',
    support: 'tested',
    existingSession: 'native_cli_queue',
    immediateNotification: 'native_cli_queue',
    busy: 'queue',
    receiptEvidence: ['harness_queued'],
    reconcileByReleaseId: 'unsupported',
    limits: { maxSelectionEvents: 32, maxPayloadBytes: 65_536 } as DeliveryLimits,
    evidenceRef: 'docs/evidence.md',
    modes: {
      steer: support('codex-steer'),
      sync: support('codex-sync'),
      async: support('codex-async'),
    },
    acknowledgement: 'batch_token_next_call',
  };
}

describe('local SQLite transport integration', () => {
  it('deduplicates a restarted transaction into one stored and replayed event', async () => {
    const root = fs.mkdtempSync('/tmp/khala-local-transport-integration-');
    roots.push(root);
    fs.chmodSync(root, 0o700);
    const directory = path.join(root, 'state');

    const initial = open(directory, 'create');
    registerIdentities(initial.store);
    const originalService = channelService(initial.store, alice, ['channel-one', 'event-original']);
    const created = await originalService.create({ operationId: 'create-one', title: 'One' });
    expect(created).toMatchObject({ kind: 'ok', value: { roomId: 'channel-one' } });
    if (created.kind !== 'ok') throw new Error('channel creation failed');
    const roomId = created.value.roomId;
    expect(initial.store.setMembership({ channelId: roomId, participantId: bob.participantId, membership: 'joined' }))
      .toMatchObject({ kind: 'done' });
    admitWithSharedHistory(initial.handle, binding, roomId);

    const content = text('restart-safe hello');
    const original = await originalService.send({ roomId, clientTxnId: 'txn-restart', content });
    expect(original).toMatchObject({
      kind: 'ok',
      value: { state: 'accepted', eventRef: { eventId: 'event-original', authorDeviceId: alice.deviceIds[0] } },
    });
    originalService.stop();
    initial.handle.close();

    const restarted = open(directory, 'existing');
    const retryService = channelService(restarted.store, alice, ['event-retry-must-not-persist']);
    const retry = await retryService.send({ roomId, clientTxnId: 'txn-restart', content });
    expect(retry).toEqual(original);

    const persisted = restarted.handle.read(db => db.prepare(`
      SELECT event_id, author_participant_id, author_device_id, client_txn_id
      FROM events WHERE channel_id = ?
    `).all(roomId) as unknown as readonly Readonly<{
      event_id: string;
      author_participant_id: string;
      author_device_id: string;
      client_txn_id: string;
    }>[]);
    expect(persisted).toEqual([{
      event_id: 'event-original',
      author_participant_id: alice.participantId,
      author_device_id: alice.deviceIds[0],
      client_txn_id: 'txn-restart',
    }]);

    const timeline = await retryService.timeline({ roomId, cursor: null, limit: 10 });
    expect(timeline).toMatchObject({
      kind: 'ok',
      value: {
        items: [{
          ref: {
            eventId: 'event-original',
            authorParticipantId: alice.participantId,
            authorDeviceId: alice.deviceIds[0],
          },
          participant: alice,
          clientTxnId: 'txn-restart',
          content,
        }],
      },
    });

    const transport = createLocalSubscriptionSource({ store: restarted.store, binding, channelId: roomId });
    let cursor: string | null = null;
    let cursorRevision = 0;
    const order: string[] = [];
    const accepted: Parameters<EventIngestionPort['accept']>[0][] = [];
    const cursors: CursorStore = {
      async load() { return { kind: 'loaded', cursor, revision: cursorRevision }; },
      async commit(input) {
        order.push(`commit:${input.opaqueCursor}`);
        if (input.expectedRevision !== cursorRevision) return { kind: 'conflict' };
        cursor = input.opaqueCursor;
        cursorRevision += 1;
        return { kind: 'committed', revision: cursorRevision };
      },
    };
    const ingestion: EventIngestionPort = {
      async accept(input) {
        order.push(`ingest:${input.event.eventId}`);
        accepted.push(input);
        return 'stored';
      },
      async acceptUnavailable() {
        throw new Error('the integration event must remain decryptable');
      },
    };
    const scheduler: Scheduler = {
      now: () => Date.parse('2026-09-24T20:00:00.000Z'),
      setTimer: () => () => {},
    };
    const subscription = await startSubscription(
      { binding, streamId: `channel:${roomId}`, pageSize: 10 },
      {
        ...transport,
        cursors,
        ingestion,
        lock: { async acquire() { return { kind: 'held', release: async () => {} }; } },
        scheduler,
        random: () => 0,
      },
    );
    await waitFor(() => subscription.state().kind === 'live' && cursorRevision === 1);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      binding,
      event: {
        eventId: 'event-original',
        authorParticipantId: alice.participantId,
        authorDeviceId: alice.deviceIds[0],
      },
      canonicalPayload: encodeMessageContent(content),
    });
    expect(order).toEqual([
      'ingest:event-original',
      expect.stringMatching(/^commit:/),
    ]);

    const bobService = channelService(restarted.store, bob, ['event-self']);
    await expect(bobService.send({ roomId, clientTxnId: 'txn-self', content: text('self-authored') }))
      .resolves.toMatchObject({ kind: 'ok', value: { state: 'accepted' } });
    await waitFor(() => cursorRevision === 2);
    expect(accepted).toHaveLength(1);
    expect(order).toHaveLength(3);
    expect(order[2]).toMatch(/^commit:/);
    expect(cursor).not.toBeNull();

    await subscription.stop();
    bobService.stop();
    retryService.stop();

    const modeService = createListeningModeService(createLocalListeningModeStore(
      createSqliteListeningModeRepository(restarted.handle),
    ));
    const owner: OwnerAuthority = {
      ownerId: binding.ownerId,
      issuer: 'https://issuer.example',
      subject: 'owner-bob',
      authenticatedAt: '2026-09-24T20:00:00.000Z',
      authorizationId: 'authorization-bob' as AuthorizationId,
    };
    const context = { binding, status: 'active' as const };
    const current = await modeService.read(owner, context, capabilities());
    expect(current).toMatchObject({ ok: true, view: { requested: 'sync', effective: 'sync', version: 1 } });
    const command: ListeningModeCommand = {
      v: 1,
      commandId: 'mode-steer' as CommandId,
      bindingId: binding.bindingId,
      expectedBindingGeneration: binding.generation,
      expectedVersion: 1,
      requested: 'steer',
      issuedAt: '2026-09-24T20:01:00.000Z',
    };
    await expect(modeService.set(owner, context, capabilities(), command)).resolves.toMatchObject({
      outcome: 'applied',
      requested: 'steer',
      effective: 'steer',
      version: 2,
    });
    restarted.handle.close();

    const reopened = open(directory, 'existing');
    const reopenedModes = createListeningModeService(createLocalListeningModeStore(
      createSqliteListeningModeRepository(reopened.handle),
    ));
    await expect(reopenedModes.read(owner, context, capabilities())).resolves.toMatchObject({
      ok: true,
      view: { requested: 'steer', effective: 'steer', version: 2 },
    });
  });
});
