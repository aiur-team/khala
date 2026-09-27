import { describe, expect, it, vi } from 'vitest';
import type { AuthPrincipal, RoomId, SessionBinding } from '@khala/contracts/messaging/index';
import { createAgentBindingStore } from '../agent-bootstrap/store';
import { createOwnerRoomIndex } from '../agent-bootstrap/owner-room-index';
import { fakeStore, T0 } from '../auth/support.test';
import { createOwnerMailbox } from '../composition/owner-mailbox/store';
import { createOwnerCleanupRequests } from './cleanup-requests';
import { createProtectedClosureConnector } from './production';
import { createChannelClosureService } from './service';

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
  it('keeps Matrix leave pending until every active binding acknowledges its stop', async () => {
    const { store } = fakeStore(() => T0);
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
      expect(await service.closeRoom(request)).toEqual(last
        ? { kind: 'ok', value: { operationId: request.operationId, state: 'complete', reason: null } }
        : partial);
      expect(leave).toHaveBeenCalledTimes(last ? 1 : 0);
    }
    expect(await cleanup.list()).toEqual({ kind: 'ok', requests: [request] });
  });
});
