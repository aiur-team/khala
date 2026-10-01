import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeDeliveryLimits, type HarnessCapabilities, type SessionBinding } from '@khala/contracts/delivery/index';
import { openConnectorStorage } from '@khala/connector/storage/open';
import { createConnectorDispatchStorage } from '@khala/connector/storage/dispatch';
import { initialTrustState } from '@khala/policy/trust/index';
import { openTrustStateStore } from '../controls/trust-store';
import { createHostedListeningControl } from './hosted-listening';

const binding: SessionBinding = { v: 1, bindingId: 'binding_listening' as never,
  ownerId: 'owner_listening' as never, agentParticipantId: 'agent_listening' as never,
  deviceId: 'device_listening' as never, harness: 'codex', sessionId: 'thread_listening', generation: 0 };
const limits = decodeDeliveryLimits({ maxSelectionEvents: 20, maxPayloadBytes: 64 * 1024 });
if (!limits.ok) throw new Error('limits');
const unknown = { status: 'unknown' as const, route: 'unproven',
  evidenceRef: null, evidenceRevision: null, reason: 'unproven' };
const sync = { status: 'proven' as const, route: 'codex-hook', testedVersion: '0.154.0',
  evidenceRef: 'hook-proof', evidenceRevision: 'hook-revision', reason: null };
const capabilities: HarnessCapabilities = {
  v: 3, harness: 'codex', version: '0.154.0', adapterVersion: 'hosted-test', support: 'tested',
  existingSession: 'native_cli_queue', immediateNotification: 'native_cli_queue', busy: 'queue',
  receiptEvidence: ['harness_queued', 'outcome_unknown', 'failed'], reconcileByReleaseId: 'while_queued',
  limits: limits.value, evidenceRef: 'hook-proof', modes: { steer: unknown, sync, async: unknown },
  acknowledgement: 'unknown',
};

describe('hosted listening mode projection', () => {
  it('grants an exact experimental route before switching its requested and effective mode', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'khala-listening-'));
    const storage = await openConnectorStorage({ directory: path.join(parent, 'state'), mode: 'create', limits: limits.value });
    const trust = await openTrustStateStore({ directory: path.join(parent, 'state'), mode: 'create' });
    try {
      await storage.ledger.transaction(tx => tx.putBinding(binding));
      const dispatch = createConnectorDispatchStorage(storage);
      await dispatch.applyEffectivePolicy({ binding, policy: { version: 0, armedAt: 0,
        paused: false, expiresAt: null, listening: { version: 0, requested: 'sync',
          effective: null, evidenceRevision: null } } });
      await trust.update(binding.bindingId, () => ({ next: initialTrustState({
        roomId: 'room_listening' as never, bindingId: binding.bindingId, ownerId: binding.ownerId,
        generation: 0, policyVersion: 0 }), result: undefined }));
      const experimental = { ...sync, status: 'experimental' as const, route: 'codex-steer' };
      const hosted = createHostedListeningControl({ binding, trust, dispatch, current: async () => true,
        capabilities: async () => ({ ...capabilities, modes: { ...capabilities.modes, steer: experimental } }) });
      const owner = { ownerId: binding.ownerId } as never;
      const before = await hosted.owner.read(owner);
      expect(before).toMatchObject({ ok: true, view: { version: 1, requested: 'sync' } });
      const grant = await hosted.owner.grant(owner, { v: 1, kind: 'grant_experimental_route',
        commandId: 'grant_steer_12345678' as never, bindingId: binding.bindingId,
        expectedBindingGeneration: 0, expectedVersion: 1, mode: 'steer',
        route: experimental.route, harnessVersion: experimental.testedVersion,
        evidenceRevision: experimental.evidenceRevision, issuedAt: '2026-09-27T00:00:00Z' });
      expect(grant).toMatchObject({ outcome: 'applied', view: { version: 2,
        experimentalGrants: [{ mode: 'steer', route: 'codex-steer' }] } });
      const changed = await hosted.owner.set(owner, { v: 1, commandId: 'mode_steer_12345678' as never,
        bindingId: binding.bindingId, expectedBindingGeneration: 0, expectedVersion: 2,
        requested: 'steer', issuedAt: '2026-09-27T00:01:00Z' });
      expect(changed).toMatchObject({ outcome: 'applied', version: 3, requested: 'steer', effective: 'steer' });
      expect(await hosted.owner.read(owner)).toMatchObject({ ok: true, view: {
        version: 3, requested: 'steer', effective: 'steer', lastChangedBy: { kind: 'owner' },
      } });
      expect((await dispatch.ledger.transact(tx => tx.policy(binding.bindingId)))?.listening)
        .toMatchObject({ requested: 'steer', effective: 'steer' });
    } finally { trust.close(); await storage.close(); await rm(parent, { recursive: true, force: true }); }
  });

  it('never reports a proven mode effective when policy dispatch acknowledges without writing', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'khala-listening-'));
    const storage = await openConnectorStorage({ directory: path.join(parent, 'state'), mode: 'create', limits: limits.value });
    const trust = await openTrustStateStore({ directory: path.join(parent, 'state'), mode: 'create' });
    try {
      await storage.ledger.transaction(tx => tx.putBinding(binding));
      const dispatch = createConnectorDispatchStorage(storage);
      await dispatch.applyEffectivePolicy({ binding, policy: { version: 0, armedAt: 0,
        paused: false, expiresAt: null, listening: { version: 0, requested: 'sync',
          effective: null, evidenceRevision: null } } });
      await trust.update(binding.bindingId, () => ({ next: initialTrustState({
        roomId: 'room_listening' as never, bindingId: binding.bindingId, ownerId: binding.ownerId,
        generation: 0, policyVersion: 0 }), result: undefined }));
      const dropped = { ...dispatch, applyEffectivePolicy: async () => ({ kind: 'applied' as const }) };
      const hosted = createHostedListeningControl({ binding, trust, dispatch: dropped,
        current: async () => true, capabilities: async () => capabilities });
      const authority = { ownerId: binding.ownerId } as never;
      expect(await hosted.owner.read(authority)).toMatchObject({ ok: true,
        view: { effective: null, effectiveReason: 'projection_unavailable' } });
      const result = await hosted.owner.set(authority, { v: 1, commandId: 'mode_dropped_12345678' as never,
        bindingId: binding.bindingId, expectedBindingGeneration: 0, expectedVersion: 1,
        requested: 'sync', issuedAt: '2026-09-27T00:00:00Z' });
      expect(result).toMatchObject({ outcome: 'applied', effective: null, reason: 'projection_unavailable' });
      expect((await dispatch.ledger.transact(tx => tx.policy(binding.bindingId)))?.listening.effective).toBeNull();
    } finally { trust.close(); await storage.close(); await rm(parent, { recursive: true, force: true }); }
  });

  it('does not attribute a concurrent listening version to the owner command', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'khala-listening-'));
    const storage = await openConnectorStorage({ directory: path.join(parent, 'state'), mode: 'create', limits: limits.value });
    const trust = await openTrustStateStore({ directory: path.join(parent, 'state'), mode: 'create' });
    try {
      await storage.ledger.transaction(tx => tx.putBinding(binding));
      const dispatch = createConnectorDispatchStorage(storage);
      await dispatch.applyEffectivePolicy({ binding, policy: { version: 0, armedAt: 0,
        paused: false, expiresAt: null, listening: { version: 0, requested: 'sync',
          effective: null, evidenceRevision: null } } });
      await trust.update(binding.bindingId, () => ({ next: initialTrustState({
        roomId: 'room_listening' as never, bindingId: binding.bindingId, ownerId: binding.ownerId,
        generation: 0, policyVersion: 0 }), result: undefined }));
      let raced = false;
      const racing = { ...dispatch, async applyEffectivePolicy(input: Parameters<typeof dispatch.applyEffectivePolicy>[0]) {
        const answer = await dispatch.applyEffectivePolicy(input);
        if (!raced) {
          raced = true;
          await trust.update(binding.bindingId, state => ({ next: { ...state!, listeningMode: {
            ...state!.listeningMode, version: state!.listeningMode.version + 1, requested: 'steer',
          } }, result: undefined }));
        }
        return answer;
      } };
      const hosted = createHostedListeningControl({ binding, trust, dispatch: racing,
        current: async () => true, capabilities: async () => ({ ...capabilities,
          modes: { ...capabilities.modes, steer: sync } }) });
      const result = await hosted.owner.set({ ownerId: binding.ownerId } as never, {
        v: 1, commandId: 'mode_raced_12345678' as never, bindingId: binding.bindingId,
        expectedBindingGeneration: 0, expectedVersion: 1, requested: 'sync', issuedAt: '2026-09-27T00:00:00Z',
      });
      expect(result).toMatchObject({ outcome: 'applied', effective: null, reason: 'projection_unavailable' });
    } finally { trust.close(); await storage.close(); await rm(parent, { recursive: true, force: true }); }
  });

  it('projects proven mode to the dispatch ledger and clears it after current authority disappears', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'khala-listening-'));
    const state = path.join(parent, 'state');
    const storage = await openConnectorStorage({ directory: state, mode: 'create', limits: limits.value });
    const trust = await openTrustStateStore({ directory: state, mode: 'create' });
    try {
      await storage.ledger.transaction(tx => tx.putBinding(binding));
      const dispatch = createConnectorDispatchStorage(storage);
      expect(await dispatch.applyEffectivePolicy({ binding, policy: { version: 0, armedAt: 0,
        paused: false, expiresAt: null, listening: { version: 0, requested: 'sync',
          effective: null, evidenceRevision: null } } })).toEqual({ kind: 'applied' });
      await trust.update(binding.bindingId, () => ({ next: initialTrustState({
        roomId: 'room_listening' as never, bindingId: binding.bindingId, ownerId: binding.ownerId,
        generation: 0, policyVersion: 0,
      }), result: undefined }));
      let current = true;
      let trustedHooks = false;
      const hosted = createHostedListeningControl({ binding, trust, dispatch,
        current: async () => current, capabilities: async () => trustedHooks ? capabilities : null });
      expect(await hosted.status()).toMatchObject({ effective: null });
      trustedHooks = true;
      expect(await hosted.status()).toMatchObject({ bindingId: binding.bindingId, effective: 'sync' });
      const projected = await dispatch.ledger.transact(tx => tx.policy(binding.bindingId));
      expect(projected?.listening).toMatchObject({ version: 2, effective: 'sync', evidenceRevision: 'hook-revision' });
      trustedHooks = false;
      expect(await hosted.status()).toMatchObject({ effective: null });
      expect((await dispatch.ledger.transact(tx => tx.policy(binding.bindingId)))?.listening)
        .toMatchObject({ version: 3, effective: null, evidenceRevision: null });
      current = false;
      expect(await hosted.application.read()).toEqual({ ok: false, code: 'unavailable' });
      expect(await hosted.status()).toMatchObject({ effective: null });
    } finally { trust.close(); await storage.close(); await rm(parent, { recursive: true, force: true }); }
  });
});
