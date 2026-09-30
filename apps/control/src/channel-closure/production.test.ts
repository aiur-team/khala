import { describe, expect, it, vi } from 'vitest';
import type { AuthPrincipal, ControlStore, RoomId, SessionBinding } from '@khala/contracts/messaging/index';
import { createAgentBindingStore } from '../agent-bootstrap/store';
import { createOwnerRoomIndex } from '../agent-bootstrap/owner-room-index';
import { fakeStore, T0 } from '../auth/support.test';
import { createOwnerMailbox } from '../composition/owner-mailbox/store';
import { createAgentRevocationCleanupRoutes, createRevocationCleanupStore, revocationStopId,
  REVOCATION_RESULT_PATH } from '../composition/human/revocation-cleanup';
import { operationJournal, journalKey } from '@khala/messaging/revocation/journal';
import type { OperationRecord } from '@khala/messaging/revocation/operation';
import { createOwnerCleanupRequests } from './cleanup-requests';
import { createProtectedClosureConnector, registerClosureHandlers } from './production';
import { createChannelClosureService } from './service';
import type { BlobsStoreLike } from '../runtime/control-store';

const roomId = '!closure:example' as RoomId;
const first = { v: 1, bindingId: 'closure-binding-one', ownerId: 'closure-owner', agentParticipantId: 'closure-agent-one',
  deviceId: 'closure-device-one', harness: 'claude', sessionId: 'closure-session-one', generation: 0 } as SessionBinding;
const second = { ...first, bindingId: 'closure-binding-two', agentParticipantId: 'closure-agent-two',
  deviceId: 'closure-device-two', sessionId: 'closure-session-two' } as SessionBinding;
const principal = { v: 1, ownerId: first.ownerId, providerIssuer: 'https://id.example', providerSubject: 'closure-owner',
  verifiedEmail: 'owner@example.test', sessionExpiresAt: new Date(T0 + 60_000).toISOString() } as AuthPrincipal;
const authoritySecret = 'mailbox-test-secret-at-least-thirty-two-bytes';
const request = { operationId: 'closure-operation', ownerId: first.ownerId, roomId, expectedRoomRevision: 0 };

describe('production closure mailbox adapter', () => {
  it('rebinds the Blobs client for cleanup reads after a warm credential expires', async () => {
    let credential: 'expired' | 'fresh' = 'expired';
    const stores = vi.fn((name: string): BlobsStoreLike => {
      void name;
      const boundCredential = credential;
      return {
        getWithMetadata: async () => {
          if (boundCredential === 'expired') throw Object.assign(new Error('expired'), { status: 401 });
          return null;
        },
        setJSON: async () => ({ modified: true, etag: '1' }),
      };
    });
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const route = registerClosureHandlers({
        loadHuman: async () => ({ auth: {
          authenticateRequest: async () => ({ kind: 'authenticated', context: { principal } }),
        }, messaging: {} }) as never,
        readEnv: () => ({ controlStateNamespace: 'test', publicHomeserverOrigin: 'https://matrix.example',
          invitationHmacSecret: authoritySecret }) as never,
        stores,
      })[0]!;
      const cleanupRequest = new Request('https://khala.aiur.team/api/human/channel-closure?cleanup=1');

      expect((await route.handle(cleanupRequest)).status).toBe(503);
      credential = 'fresh';
      const response = await route.handle(cleanupRequest);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ kind: 'ok', value: [] });
      expect(stores).toHaveBeenCalledWith('test-records');
    } finally { log.mockRestore(); }
  });

  it('returns a redacted 503 when the human loader rejects before route setup', async () => {
    const output: string[] = [];
    const log = vi.spyOn(console, 'info').mockImplementation(value => { output.push(String(value)); });
    try {
      const route = registerClosureHandlers({
        loadHuman: async () => { throw new Error('private-cookie secret-room'); },
      })[0]!;
      const response = await route.handle(new Request('https://khala.aiur.team/api/human/channel-closure?cleanup=1'));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ code: 'unavailable' });
      expect(output).toEqual(['{"component":"channel-closure","stage":"loader_rejected"}']);
    } finally { log.mockRestore(); }
  });
  it('classifies environment and store access failures without exposing adapter errors', async () => {
    const output: string[] = [];
    const log = vi.spyOn(console, 'info').mockImplementation(value => { output.push(String(value)); });
    const loadHuman = async () => ({ auth: {
      authenticateRequest: async () => ({ kind: 'authenticated', context: { principal } }),
    }, messaging: {} }) as never;
    const request = new Request('https://khala.aiur.team/api/human/channel-closure?cleanup=1');
    try {
      const badEnv = registerClosureHandlers({ loadHuman,
        readEnv: () => { throw new Error('private-cookie secret-room'); } })[0]!;
      const envResponse = await badEnv.handle(request);
      expect(envResponse.status).toBe(503);
      expect(await envResponse.json()).toEqual({ code: 'unavailable' });

      const badStore = registerClosureHandlers({ loadHuman,
        readEnv: () => ({ controlStateNamespace: 'test', publicHomeserverOrigin: 'https://matrix.example',
          invitationHmacSecret: 'test' }) as never,
        stores: () => { throw new Error('private-cookie secret-room'); } })[0]!;
      const storeResponse = await badStore.handle(request);
      expect(storeResponse.status).toBe(503);
      expect(await storeResponse.json()).toEqual({ code: 'unavailable' });
      expect(output).toEqual([
        '{"component":"channel-closure","stage":"environment_rejected"}',
        '{"component":"channel-closure","stage":"store_read_error"}',
        '{"component":"channel-closure","stage":"cleanup_unavailable"}',
      ]);
    } finally { log.mockRestore(); }
  });
  it.each(['no_removal', 'uia_only', 'legacy_removal'] as const)(
    'requires the revoked endpoint’s durable local Stop before revoke-then-close can leave (%s)', async mode => {
    const store = fakeStore(() => T0).store;
    const bindings = createAgentBindingStore({ store });
    const index = createOwnerRoomIndex(store);
    for (const binding of [first, second]) {
      expect((await bindings.putParticipant({ ownerId: binding.ownerId, roomId, agentParticipantId: binding.agentParticipantId,
        expectedBindingId: null, record: { binding, revokedGeneration: null, capability: null } })).kind).toBe('applied');
      expect((await index.activate(binding, roomId)).kind).toBe('ok');
    }
    expect(await bindings.updateBinding(first.bindingId, record => ({ ...record,
      revokedGeneration: first.generation + 1, capability: null }))).toBe('applied');
    const revokeId = 'revoke-before-close';
    const deviceKey = 'B'.repeat(43);
    const revocations = createRevocationCleanupStore(store);
    expect(await revocations.prepare({ ownerId: principal.ownerId, operationId: revokeId,
      bindingId: first.bindingId, roomId, deviceId: first.deviceId, deviceKey,
      expectedGeneration: first.generation, revokedGeneration: first.generation + 1,
      capabilityDigest: 'a'.repeat(43) })).toBe('applied');
    const record: OperationRecord = { v: 2, ownerId: principal.ownerId, operationId: revokeId,
      targetKind: 'binding', targetId: first.bindingId, expectedGeneration: first.generation,
      revokedGeneration: first.generation + 1, deviceId: first.deviceId, deviceKey,
      control: 'disabled', capability: 'revoked', removal: 'pending', removalRefusal: null,
      rotation: 'pending', endpoint: 'pending', seq: 0 };
    const key = await journalKey(principal.ownerId, revokeId);
    expect(key).not.toBeNull();
    expect((await operationJournal(principal.ownerId, store).create(key!, record)).kind).toBe('applied');
    const connector = createProtectedClosureConnector({ store, principal, clock: () => T0, authoritySecret });
    const cleanup = createOwnerCleanupRequests(store, principal.ownerId);
    const leave = vi.fn(async () => 'left' as const);
    const service = createChannelClosureService({ principal, store, transport: {
      connectorConfigured: true, membership: async () => 'joined',
      stopConnectorDelivery: command => connector.stopDelivery(command), leave,
      requestLocalCleanup: command => cleanup.record(command),
    } });
    const partial = { kind: 'ok', value: { operationId: request.operationId,
      state: 'partial', reason: 'dependency_unavailable' } };
    expect(await service.closeRoom(request)).toEqual(partial);
    const activeMailbox = createOwnerMailbox({ store, binding: second, roomId, clock: () => T0, authoritySecret });
    expect((await activeMailbox.complete(request.operationId, { kind: 'stopped', receipt: {
      ...request, bindingId: second.bindingId, bindingGeneration: second.generation,
      state: 'stopped', cleanupRequested: true,
    } })).kind).toBe('ok');
    expect(await service.closeRoom(request)).toEqual(partial);
    expect(leave).not.toHaveBeenCalled();
    const stop = { operationId: revocationStopId(revokeId, first.bindingId), ownerId: principal.ownerId,
      roomId, expectedRoomRevision: 0 as const, bindingId: first.bindingId,
      bindingGeneration: first.generation, state: 'stopped' as const, cleanupRequested: true as const };
    if (mode === 'uia_only') {
      expect(await revocations.recordVerifiedRemoval(principal.ownerId, revokeId, 'removed')).toBe('applied');
    }
    if (mode === 'legacy_removal') {
      expect(await revocations.recordRemoval(principal.ownerId, revokeId, 'removed')).toBe('applied');
    }
    expect(await service.closeRoom(request)).toEqual(partial);
    const resultRoute = createAgentRevocationCleanupRoutes({ store, capabilities: {
      async authorizeRevocationCleanup() { return { kind: 'authorized' as const, ownerId: principal.ownerId,
        roomId, binding: first, revokedGeneration: first.generation + 1, capabilityDigest: 'a'.repeat(43) }; },
    } }).find(route => route.path === REVOCATION_RESULT_PATH)!;
    const report = (localStop: unknown) => resultRoute.handle(new Request(`https://khala.aiur.team${REVOCATION_RESULT_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        operationId: revokeId, deviceId: first.deviceId, deviceKey, generation: first.generation,
        removal: null, localStop,
      }),
    }));
    expect((await report({ ...stop, ownerId: 'peer-owner' })).status).toBe(503);
    expect((await report({ ...stop, roomId: '!peer:example' })).status).toBe(503);
    expect((await report({ ...stop, bindingGeneration: first.generation + 1 })).status).toBe(503);
    expect(await service.closeRoom(request)).toEqual(partial);
    expect((await report(stop)).status).toBe(200);
    expect((await report(stop)).status).toBe(200);
    expect((await report({ ...stop, operationId: `revoke_${'a'.repeat(40)}` })).status).toBe(503);
    expect((await revocations.read(principal.ownerId, revokeId)).kind).toBe('record');
    expect(await service.closeRoom(request)).toEqual({ kind: 'ok', value: {
      operationId: request.operationId, state: 'complete', reason: null,
    } });
    expect(leave).toHaveBeenCalledOnce();
    const removalReport = (removal: 'removed' | 'replaced') => resultRoute.handle(new Request(
      `https://khala.aiur.team${REVOCATION_RESULT_PATH}`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId: revokeId,
          deviceId: first.deviceId, deviceKey, generation: first.generation, removal }) }));
    expect((await removalReport('removed')).status).toBe(200);
    expect((await removalReport('replaced')).status).toBe(503);
    expect(await cleanup.list()).toEqual({ kind: 'ok', requests: [request] });
  });
  it('keeps Matrix leave pending until every active binding acknowledges its stop', async () => {
    const state = fakeStore(() => T0);
    let failCleanupWrite = false;
    const store: ControlStore = { ...state.store, compareAndSet: input => {
      if (failCleanupWrite && input.key.startsWith('channel-closure:cleanup:')) return Promise.resolve({ kind: 'unavailable' });
      return state.store.compareAndSet(input);
    } };
    const bindings = createAgentBindingStore({ store });
    const index = createOwnerRoomIndex(store);
    for (const binding of [first, second]) {
      expect((await bindings.putParticipant({ ownerId: binding.ownerId, roomId, agentParticipantId: binding.agentParticipantId,
        expectedBindingId: null, record: { binding, revokedGeneration: null, capability: null } })).kind).toBe('applied');
      expect((await index.activate(binding, roomId)).kind).toBe('ok');
    }
    const connector = createProtectedClosureConnector({ store, principal, clock: () => T0, authoritySecret });
    const cleanup = createOwnerCleanupRequests(store, principal.ownerId);
    const leave = vi.fn(async () => 'left' as const);
    const service = createChannelClosureService({ principal, store, transport: {
      connectorConfigured: true,
      membership: async () => 'joined',
      stopConnectorDelivery: command => connector.stopDelivery(command),
      leave,
      requestLocalCleanup: command => cleanup.record(command),
    } });
    const partial = { kind: 'ok', value: { operationId: request.operationId, state: 'partial', reason: 'dependency_unavailable' } };
    expect(await service.closeRoom(request)).toEqual(partial);
    expect(leave).not.toHaveBeenCalled();
    expect((await index.activate({ ...first, bindingId: 'closure-binding-late' } as SessionBinding, roomId)).kind).toBe('closed');

    for (const [binding, last] of [[first, false], [second, true]] as const) {
      const mailbox = createOwnerMailbox({ store, binding, roomId, clock: () => T0, authoritySecret });
      expect((await mailbox.complete(request.operationId, { kind: 'stopped', receipt: {
        ...request, bindingId: binding.bindingId, bindingGeneration: binding.generation,
        state: 'stopped', cleanupRequested: true,
      } })).kind).toBe('ok');
      if (last) {
        failCleanupWrite = true;
        expect(await service.closeRoom(request)).toEqual({ kind: 'ok', value: {
          operationId: request.operationId, state: 'partial', reason: 'local_cleanup_failed',
        } });
        expect(await cleanup.list()).toEqual({ kind: 'ok', requests: [] });
        failCleanupWrite = false;
        expect(await service.closeRoom(request)).toEqual({ kind: 'ok', value: {
          operationId: request.operationId, state: 'complete', reason: null,
        } });
      } else expect(await service.closeRoom(request)).toEqual(partial);
      expect(leave).toHaveBeenCalledTimes(last ? 1 : 0);
    }
    expect(await cleanup.list()).toEqual({ kind: 'ok', requests: [request] });
  });
});
