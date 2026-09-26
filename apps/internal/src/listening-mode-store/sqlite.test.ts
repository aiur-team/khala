import fs from 'node:fs';
import path from 'node:path';
import type {
  BindingId, DeliveryLimits, DeviceId, HarnessCapabilities, ListeningModeControl,
  OwnerId, ParticipantId, RouteGrant, SessionBinding,
} from '@khala/contracts/delivery/index';
import { afterEach, describe, expect, it } from 'vitest';
import { listeningModeStoreConformance } from '../../../../packages/policy/test/fixtures/listening-mode/conformance';
import { listeningModeView, type ListeningModeStoreWrite } from '@khala/policy/listening-mode/store';
import { createLocalListeningModeStore } from '../composition/local-transport/listening-mode-store';
import { createChannelStore } from '../store/channel-store';
import { openChannelStore, type InternalStoreHandle } from '../store/open';
import { createSqliteListeningModeRepository } from './sqlite';

const roots: string[] = [];
const handles: InternalStoreHandle[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const binding: SessionBinding = {
  v: 1,
  bindingId: 'binding-mode' as BindingId,
  ownerId: 'owner-mode' as OwnerId,
  agentParticipantId: 'participant-mode' as ParticipantId,
  deviceId: 'device-mode' as DeviceId,
  harness: 'codex',
  sessionId: 'session-mode',
  generation: 3,
};

const initial = (): ListeningModeControl => ({
  bindingId: binding.bindingId,
  generation: binding.generation,
  requested: 'sync',
  version: 1,
  experimentalGrants: [],
  hardCancelGrants: [],
  lastChangedBy: { kind: 'unknown' },
});

function fresh() {
  const root = fs.mkdtempSync('/tmp/khala-listening-mode-');
  roots.push(root);
  fs.chmodSync(root, 0o700);
  const directory = path.join(root, 'state');
  const handle = openChannelStore({ directory, mode: 'create' });
  handles.push(handle);
  const channels = createChannelStore(handle);
  expect(channels.registerParticipant({
    participantId: binding.agentParticipantId,
    ownerId: binding.ownerId,
    kind: 'agent',
    displayName: 'Mode agent',
  })).toMatchObject({ kind: 'done' });
  expect(channels.registerDevice({ deviceId: binding.deviceId, participantId: binding.agentParticipantId }))
    .toMatchObject({ kind: 'done' });
  expect(channels.registerBinding(binding)).toMatchObject({ kind: 'done' });
  const repository = createSqliteListeningModeRepository(handle);
  return { directory, handle, repository, store: createLocalListeningModeStore(repository) };
}

function write(
  operationId: string,
  expectedVersion: number | null,
  requested: ListeningModeControl['requested'],
  next: Partial<ListeningModeStoreWrite['next']> = {},
): ListeningModeStoreWrite {
  return {
    key: { bindingId: binding.bindingId, generation: binding.generation },
    expectedVersion,
    operationId,
    operationFingerprint: JSON.stringify([operationId, expectedVersion, requested]),
    next: {
      requested,
      experimentalGrants: [],
      hardCancelGrants: [],
      lastChangedBy: { kind: 'unknown' },
      ...next,
    },
  };
}

listeningModeStoreConformance('sqlite', () => {
  const fixture = fresh();
  expect(fixture.repository.initialize(initial())).toBe(true);
  return {
    store: fixture.store,
    key: { bindingId: binding.bindingId, generation: binding.generation },
    initial: initial(),
  };
});

describe('sqlite listening-mode repository', () => {
  it('creates an absent exact key and journals a null-current conflict before later state exists', async () => {
    const { store } = fresh();
    const key = { bindingId: binding.bindingId, generation: binding.generation };
    await expect(store.read(key)).resolves.toEqual({ kind: 'absent' });

    const future = write('future-before-create', 2, 'steer');
    await expect(store.compareAndSet(future)).resolves.toEqual({ kind: 'conflict', current: null });
    await expect(store.compareAndSet(write('create', null, 'sync'))).resolves.toEqual({
      kind: 'applied',
      control: initial(),
    });
    await expect(store.compareAndSet(future)).resolves.toEqual({ kind: 'conflict', current: null });
    await expect(store.compareAndSet({ ...future, operationFingerprint: 'changed' }))
      .resolves.toEqual({ kind: 'idempotency_conflict' });
  });

  it('replays exact applied and conflict snapshots after intervening writes and restart', async () => {
    const fixture = fresh();
    expect(fixture.repository.initialize(initial())).toBe(true);
    const appliedWrite = write('applied-before-restart', 1, 'steer');
    const applied = await fixture.store.compareAndSet(appliedWrite);
    const conflictWrite = write('conflict-before-restart', 1, 'async');
    const conflict = await fixture.store.compareAndSet(conflictWrite);
    await expect(fixture.store.compareAndSet(write('intervening', 2, 'async')))
      .resolves.toMatchObject({ kind: 'applied', control: { version: 3 } });

    fixture.handle.close();
    const reopened = openChannelStore({ directory: fixture.directory, mode: 'existing' });
    handles.push(reopened);
    const restarted = createLocalListeningModeStore(createSqliteListeningModeRepository(reopened));
    await expect(restarted.compareAndSet(appliedWrite)).resolves.toEqual(applied);
    await expect(restarted.compareAndSet(conflictWrite)).resolves.toEqual(conflict);
  });

  it('rolls back both control and journal when failure occurs between them', async () => {
    const fixture = fresh();
    expect(fixture.repository.initialize(initial())).toBe(true);
    const failedWrite = write('rollback-operation', 1, 'steer');
    const failing = createLocalListeningModeStore(createSqliteListeningModeRepository(fixture.handle, {
      beforeOperationJournal: () => { throw new Error('injected failure'); },
    }));

    await expect(failing.compareAndSet(failedWrite)).resolves.toEqual({ kind: 'unavailable' });
    await expect(fixture.store.read(failedWrite.key)).resolves.toEqual({ kind: 'record', control: initial() });
    await expect(fixture.store.compareAndSet(failedWrite))
      .resolves.toMatchObject({ kind: 'applied', control: { version: 2, requested: 'steer' } });
  });

  it('preserves grants while storing requested intent without capability projections', async () => {
    const fixture = fresh();
    expect(fixture.repository.initialize(initial())).toBe(true);
    const experimental: RouteGrant = {
      v: 1,
      kind: 'experimental_route',
      bindingId: binding.bindingId,
      generation: binding.generation,
      mode: 'steer',
      route: 'codex-steer',
      harnessVersion: '1.0.0',
      evidenceRevision: 'evidence-1',
      grantRevision: 2,
    };
    const hardCancel: RouteGrant = {
      ...experimental,
      kind: 'hard_cancel',
      mode: 'async',
      route: 'codex-async',
    };
    await expect(fixture.store.compareAndSet(write('grants', 1, 'steer', {
      experimentalGrants: [experimental],
      hardCancelGrants: [hardCancel],
    }))).resolves.toMatchObject({
      kind: 'applied',
      control: { experimentalGrants: [experimental], hardCancelGrants: [hardCancel] },
    });

    const persisted = fixture.handle.read(db => ({
      control: db.prepare('SELECT * FROM mode_controls').get() as Record<string, unknown>,
      operation: db.prepare('SELECT * FROM mode_operations WHERE operation_id = ?').get('grants') as Record<string, unknown>,
    }));
    expect(Object.keys(persisted.control).sort()).toEqual([
      'binding_id', 'experimental_grants', 'generation', 'hard_cancel_grants', 'last_changed_by', 'requested', 'version',
    ]);
    expect(JSON.stringify(persisted)).not.toMatch(/effective|support|capabilit/i);
  });

  it('reads pre-actor rows and journal snapshots as unknown and then records the next actor', async () => {
    const fixture = fresh();
    const key = { bindingId: binding.bindingId, generation: binding.generation };
    expect(fixture.repository.initialize(initial())).toBe(true);
    const legacy = { ...initial(), version: 2 } as Record<string, unknown>;
    delete legacy.lastChangedBy;
    fixture.handle.transaction(db => {
      db.prepare('UPDATE mode_controls SET last_changed_by = NULL, version = 2').run();
      db.prepare(`INSERT INTO mode_operations (binding_id, generation, operation_id, fingerprint, result_kind, result_control)
        VALUES (?, ?, 'legacy-op', 'fp', 'applied', ?)`).run(key.bindingId, key.generation, JSON.stringify(legacy));
    });
    await expect(fixture.store.read(key)).resolves.toMatchObject({
      kind: 'record', control: { version: 2, lastChangedBy: { kind: 'unknown' } },
    });
    await expect(fixture.store.compareAndSet({
      ...write('legacy-op', 1, 'sync'), operationFingerprint: 'fp',
    })).resolves.toMatchObject({ kind: 'applied', control: { lastChangedBy: { kind: 'unknown' } } });

    const actor = { kind: 'agent' as const, participantId: binding.agentParticipantId };
    await expect(fixture.store.compareAndSet(write('actor-op', 2, 'async', { lastChangedBy: actor })))
      .resolves.toMatchObject({ kind: 'applied', control: { version: 3, lastChangedBy: actor } });
    await expect(fixture.store.read(key)).resolves.toMatchObject({ control: { lastChangedBy: actor } });
  });

  it('derives different effective views from unchanged durable intent', async () => {
    const fixture = fresh();
    const control = { ...initial(), requested: 'steer' as const };
    expect(fixture.repository.initialize(control)).toBe(true);
    const before = await fixture.store.read({ bindingId: binding.bindingId, generation: binding.generation });
    expect(before).toEqual({ kind: 'record', control });

    expect(listeningModeView(control, capabilities('proven')).effective).toBe('steer');
    expect(listeningModeView(control, capabilities('unsupported')).effective).toBeNull();
    await expect(fixture.store.read({ bindingId: binding.bindingId, generation: binding.generation }))
      .resolves.toEqual(before);
  });

  it('fails unavailable for malformed grants and divergent operation snapshots', async () => {
    const malformed = fresh();
    expect(malformed.repository.initialize(initial())).toBe(true);
    malformed.handle.transaction(db => {
      db.prepare('UPDATE mode_controls SET experimental_grants = ?').run('{}');
    });
    await expect(malformed.store.read({ bindingId: binding.bindingId, generation: binding.generation }))
      .resolves.toEqual({ kind: 'unavailable' });

    const divergent = fresh();
    expect(divergent.repository.initialize(initial())).toBe(true);
    const settled = write('divergent-operation', 1, 'steer');
    await expect(divergent.store.compareAndSet(settled)).resolves.toMatchObject({ kind: 'applied' });
    divergent.handle.transaction(db => {
      const snapshot = { ...initial(), bindingId: 'other-binding', version: 2, requested: 'steer' };
      db.prepare('UPDATE mode_operations SET result_control = ? WHERE operation_id = ?')
        .run(JSON.stringify(snapshot), settled.operationId);
    });
    await expect(divergent.store.compareAndSet(settled)).resolves.toEqual({ kind: 'unavailable' });
  });
});

function capabilities(steer: 'proven' | 'unsupported'): HarnessCapabilities {
  const support = (status: 'proven' | 'unsupported', route: string) => status === 'proven'
    ? {
        status,
        route,
        testedVersion: '1.0.0',
        evidenceRef: 'docs/evidence.md',
        evidenceRevision: 'evidence-1',
        reason: null,
      } as const
    : {
        status,
        route,
        testedVersion: '1.0.0',
        evidenceRef: 'docs/evidence.md',
        evidenceRevision: 'evidence-1',
        reason: 'Unsupported.',
      } as const;
  return {
    v: 3,
    harness: 'codex',
    version: '1.0.0',
    adapterVersion: 'adapter-1',
    support: 'tested',
    existingSession: 'agent_installed_listener',
    immediateNotification: 'agent_installed_listener',
    busy: 'queue',
    receiptEvidence: ['harness_queued'],
    reconcileByReleaseId: 'unsupported',
    limits: { maxSelectionEvents: 32, maxPayloadBytes: 65_536 } as DeliveryLimits,
    evidenceRef: 'docs/evidence.md',
    modes: {
      steer: support(steer, 'codex-steer'),
      sync: support('proven', 'codex-sync'),
      async: support('proven', 'codex-async'),
    },
    acknowledgement: 'batch_token_next_call',
  };
}
