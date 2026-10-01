import { describe, expect, it } from 'vitest';
import { decodeDeliveryLimits, type HarnessCapabilities, type SessionBinding } from '@khala/contracts/delivery/index';
import type { ConnectorDispatchStorage } from '@khala/connector/storage/dispatch';
import type { DispatchPolicy } from '@khala/connector/dispatch/types';
import { initialTrustState, type TrustState } from '@khala/policy/trust/index';
import { createHostedListeningControl } from './hosted-listening';

const binding: SessionBinding = { v: 1, bindingId: 'binding_readback' as never,
  ownerId: 'owner_readback' as never, agentParticipantId: 'agent_readback' as never,
  deviceId: 'device_readback' as never, harness: 'codex', sessionId: 'thread_readback', generation: 0 };
const support = { status: 'proven' as const, route: 'codex-hook', testedVersion: '0.154.0',
  evidenceRef: 'hook-proof', evidenceRevision: 'hook-revision', reason: null };
const unknown = { status: 'unknown' as const, route: 'unproven', evidenceRef: null,
  evidenceRevision: null, reason: 'unproven' };
const decodedLimits = decodeDeliveryLimits({ maxSelectionEvents: 20, maxPayloadBytes: 64 * 1024 });
if (!decodedLimits.ok) throw new Error('limits');
const capabilities = { v: 3, harness: 'codex', version: '0.154.0', adapterVersion: 'hosted-test',
  support: 'tested', existingSession: 'native_cli_queue', immediateNotification: 'native_cli_queue',
  busy: 'queue', receiptEvidence: [], reconcileByReleaseId: 'while_queued',
  limits: decodedLimits.value, evidenceRef: 'hook-proof',
  modes: { steer: support, sync: support, async: unknown }, acknowledgement: 'unknown' } as HarnessCapabilities;

function fixture(options: { drop?: boolean; race?: boolean; experimental?: boolean;
  drift?: 'unavailable' | 'evidence'; driftAfter?: number } = {}) {
  let state: TrustState = initialTrustState({ roomId: 'room_readback' as never,
    bindingId: binding.bindingId, ownerId: binding.ownerId, generation: 0, policyVersion: 0 });
  let revision = 0;
  let policy: DispatchPolicy = { version: 0, armedAt: 0, paused: false, expiresAt: null,
    listening: { version: 0, requested: 'sync', effective: null, evidenceRevision: null } };
  let writes = 0;
  const trust = {
    async read() { return state; },
    async update<T>(_id: unknown, work: (current: TrustState) => { next: TrustState; result: T }) {
      const next = work(state); state = next.next; revision += 1; return next.result;
    },
    async snapshot() { return { revision: String(revision), state }; },
    async compareAndSet(_id: unknown, expected: string, next: TrustState) {
      if (expected !== String(revision)) return 'conflict' as const;
      state = next; revision += 1; return 'applied' as const;
    },
  };
  const dispatch = {
    ledger: { async transact<T>(work: (tx: unknown) => T): Promise<T> {
      return work({ binding: () => ({ binding, revoked: false }), policy: () => policy });
    } },
    async applyEffectivePolicy(input: { policy: DispatchPolicy }) {
      writes += 1;
      if (!options.drop) policy = input.policy;
      if (options.race && writes === 1) {
        state = { ...state, listeningMode: { ...state.listeningMode,
          version: state.listeningMode.version + 1, requested: 'steer' } };
        revision += 1;
      }
      return { kind: 'applied' as const };
    },
  } as unknown as ConnectorDispatchStorage;
  const tested = options.experimental ? { ...capabilities,
    modes: { ...capabilities.modes, steer: { ...support, status: 'experimental' as const } } } : capabilities;
  let inspections = 0;
  const hosted = createHostedListeningControl({ binding, trust, dispatch,
    current: async () => true, capabilities: async () => {
      inspections += 1;
      if (inspections > (options.driftAfter ?? 1) && options.drift === 'unavailable') return null;
      if (inspections > (options.driftAfter ?? 1) && options.drift === 'evidence') return { ...tested,
        modes: { ...tested.modes, sync: { ...support, evidenceRevision: 'hook-revision-new' } } };
      return tested;
    } });
  return { hosted, trust, dispatch, policy: () => policy };
}
const owner = { ownerId: binding.ownerId } as never;
const command = (requested: 'sync' | 'steer', version = 1) => ({ v: 1 as const,
  commandId: `mode_${requested}_12345678` as never, bindingId: binding.bindingId,
  expectedBindingGeneration: 0, expectedVersion: version, requested,
  issuedAt: '2026-09-27T00:00:00Z' });

describe('hosted listening ledger readback', () => {
  it.each(['unavailable', 'evidence'] as const)(
    'fails closed when capability %s changes after ledger confirmation', async drift => {
      const { hosted } = fixture({ drift });
      expect(await hosted.owner.read(owner)).toMatchObject({ ok: true,
        view: { requested: 'sync', effective: null, effectiveReason: 'projection_unavailable' } });
    });
  it('applies the same capability fence to agent self-read', async () => {
    const { hosted } = fixture({ drift: 'evidence' });
    expect(await hosted.application.read()).toMatchObject({ ok: true,
      view: { requested: 'sync', effective: null, effectiveReason: 'projection_unavailable' } });
  });
  it.each(['owner', 'agent'] as const)(
    'does not report %s set effective when evidence changes on the final result read', async actor => {
      const { hosted } = fixture({ drift: 'evidence', driftAfter: 3 });
      const result = actor === 'owner'
        ? await hosted.owner.set(owner, command('sync'))
        : await hosted.application.set({ commandId: 'agent_set_12345678' as never,
          expectedVersion: 1, requested: 'sync', issuedAt: '2026-09-27T00:00:00Z' });
      expect(result).toMatchObject({ outcome: 'applied', effective: null,
        reason: 'projection_unavailable' });
    });
  it('fails closed when dispatch reports applied but drops the write', async () => {
    const { hosted, policy } = fixture({ drop: true });
    expect(await hosted.owner.read(owner)).toMatchObject({ ok: true,
      view: { effective: null, effectiveReason: 'projection_unavailable' } });
    expect(await hosted.owner.set(owner, command('sync'))).toMatchObject({
      outcome: 'applied', effective: null, reason: 'projection_unavailable' });
    expect(policy().listening.effective).toBeNull();
  });
  it('does not attribute a concurrent change to the earlier owner command', async () => {
    const { hosted } = fixture({ race: true });
    expect(await hosted.owner.set(owner, command('sync'))).toMatchObject({
      outcome: 'applied', effective: null, reason: 'projection_unavailable' });
  });
  it('never advances the ledger from an older owner read after a newer mode command', async () => {
    const { hosted: newer, trust, dispatch, policy } = fixture();
    expect(await newer.owner.set(owner, command('steer'))).toMatchObject({
      outcome: 'applied', version: 2, requested: 'steer' });
    let releaseRead!: () => void;
    const heldRead = new Promise<void>(resolve => { releaseRead = resolve; });
    let capturedRead!: () => void;
    const captured = new Promise<void>(resolve => { capturedRead = resolve; });
    let inspections = 0;
    const older = createHostedListeningControl({ binding, trust, dispatch,
      current: async () => true,
      capabilities: async () => {
        inspections += 1;
        if (inspections === 2) { capturedRead(); await heldRead; }
        return capabilities;
      } });
    const staleRead = older.owner.read(owner);
    await captured;
    expect(await newer.owner.set(owner, command('sync', 2))).toMatchObject({
      outcome: 'applied', version: 3, requested: 'sync', effective: 'sync' });
    const confirmedLedger = policy().listening;
    releaseRead();
    expect(await staleRead).toMatchObject({ ok: true,
      view: { requested: 'steer', effective: null, effectiveReason: 'projection_unavailable' } });
    expect(policy().listening).toEqual(confirmedLedger);
    expect(policy().listening).toMatchObject({ requested: 'sync', effective: 'sync' });
  });
  it('projects an owner grant and exact experimental mode from the shared store', async () => {
    const { hosted, policy } = fixture({ experimental: true });
    expect(await hosted.owner.grant(owner, { v: 1, kind: 'grant_experimental_route',
      commandId: 'grant_steer_12345678' as never, bindingId: binding.bindingId,
      expectedBindingGeneration: 0, expectedVersion: 1, mode: 'steer', route: support.route,
      harnessVersion: support.testedVersion, evidenceRevision: support.evidenceRevision,
      issuedAt: '2026-09-27T00:00:00Z' })).toMatchObject({ outcome: 'applied',
      view: { version: 2, experimentalGrants: [{ mode: 'steer' }] } });
    expect(await hosted.owner.set(owner, command('steer', 2))).toMatchObject({
      outcome: 'applied', version: 3, requested: 'steer', effective: 'steer' });
    expect(policy().listening).toMatchObject({ requested: 'steer', effective: 'steer' });
  });
});
