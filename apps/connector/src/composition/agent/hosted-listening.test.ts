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
