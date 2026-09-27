import { describe, expect, it } from 'vitest';
import type { AuthPrincipal, RoomId, SessionBinding } from '@khala/contracts/messaging/index';
import { createAgentBindingStore } from '../../agent-bootstrap/store';
import { createOwnerRoomIndex } from '../../agent-bootstrap/owner-room-index';
import { fakeStore, T0 } from '../../auth/support.test';
import { createOwnerMailbox } from './store';
import { createOwnerRoomClosureConnector } from './closure';

const roomId = '!room:example' as RoomId;
const binding = { v: 1, bindingId: 'binding-one', ownerId: 'owner-one', agentParticipantId: 'agent-one',
  deviceId: 'device-one', harness: 'claude', sessionId: 'session-one', generation: 0 } as SessionBinding;
const second = { ...binding, bindingId: 'binding-two', agentParticipantId: 'agent-two', deviceId: 'device-two',
  sessionId: 'session-two' } as SessionBinding;
const principal = { v: 1, ownerId: binding.ownerId, providerIssuer: 'https://id.example', providerSubject: 'owner-subject',
  verifiedEmail: 'owner@example.test', sessionExpiresAt: new Date(T0 + 60_000).toISOString() } as AuthPrincipal;
const secret = 'mailbox-test-secret-at-least-thirty-two-bytes';
const request = { operationId: 'close_operation_one', ownerId: binding.ownerId, roomId, expectedRoomRevision: 0 };

describe('protected closure connector aggregate', () => {
  it('queues Stop after 64 completed owner commands without losing their durable results', async () => {
    const state = fakeStore(() => T0);
    const bindings = createAgentBindingStore({ store: state.store });
    const index = createOwnerRoomIndex(state.store);
    expect((await bindings.putParticipant({ ownerId: binding.ownerId, roomId, agentParticipantId: binding.agentParticipantId,
      expectedBindingId: null, record: { binding, revokedGeneration: null, capability: null } })).kind).toBe('applied');
    expect((await index.activate(binding, roomId)).kind).toBe('ok');
    const mailbox = createOwnerMailbox({ store: state.store, binding, roomId, clock: () => T0, authoritySecret: secret });
    for (let i = 0; i < 64; i++) {
      const command = { operationId: `status_${i.toString().padStart(8, '0')}`, kind: 'controls_status' as const,
        body: { bindingId: binding.bindingId } };
      expect((await mailbox.submit(command, principal)).kind).toBe('ok');
      expect((await mailbox.complete(command.operationId, { ok: false, code: 'forbidden' })).kind).toBe('ok');
    }
    const closure = createOwnerRoomClosureConnector({ store: state.store, principal, clock: () => T0, authoritySecret: secret });
    expect(await closure.stopDelivery(request)).toEqual({ kind: 'pending' });
    expect((await mailbox.pending())).toMatchObject({ kind: 'ok', value: [{ operationId: request.operationId }] });
    expect((await mailbox.result('status_00000000'))).toMatchObject({ kind: 'ok', value: { outcome: { ok: false, code: 'forbidden' } } });
    expect((await mailbox.submit({ operationId: 'status_extra', kind: 'controls_status', body: { bindingId: binding.bindingId } }, principal)))
      .toEqual({ kind: 'unavailable' });
    expect((await mailbox.complete(request.operationId, { kind: 'stopped', receipt: {
      ...request, bindingId: binding.bindingId, bindingGeneration: binding.generation,
      state: 'stopped', cleanupRequested: true,
    } })).kind).toBe('ok');
    expect(await closure.stopDelivery(request)).toMatchObject({ kind: 'stopped', receipt: { activeBindingCount: 1 } });
  });

  it('stays pending until every indexed endpoint records its exact durable stop', async () => {
    const state = fakeStore(() => T0);
    const bindings = createAgentBindingStore({ store: state.store });
    const index = createOwnerRoomIndex(state.store);
    for (const current of [binding, second]) {
      expect((await bindings.putParticipant({ ownerId: current.ownerId, roomId, agentParticipantId: current.agentParticipantId,
        expectedBindingId: null, record: { binding: current, revokedGeneration: null, capability: null } })).kind).toBe('applied');
      expect((await index.activate(current, roomId)).kind).toBe('ok');
    }
    const closure = createOwnerRoomClosureConnector({ store: state.store, principal, clock: () => T0, authoritySecret: secret });
    expect(await closure.stopDelivery(request)).toEqual({ kind: 'pending' });
    expect((await index.activate({ ...binding, bindingId: 'binding-three' } as SessionBinding, roomId)).kind).toBe('closed');
    const firstMailbox = createOwnerMailbox({ store: state.store, binding, roomId, clock: () => T0, authoritySecret: secret });
    const firstReceipt = { ...request, bindingId: binding.bindingId, bindingGeneration: 0, state: 'stopped', cleanupRequested: true };
    expect((await firstMailbox.complete(request.operationId, { kind: 'stopped', receipt: firstReceipt })).kind).toBe('ok');
    expect(await closure.stopDelivery(request)).toEqual({ kind: 'pending' });
    const secondMailbox = createOwnerMailbox({ store: state.store, binding: second, roomId, clock: () => T0, authoritySecret: secret });
    const secondReceipt = { ...request, bindingId: second.bindingId, bindingGeneration: 0, state: 'stopped', cleanupRequested: true };
    expect((await secondMailbox.complete(request.operationId, { kind: 'stopped', receipt: secondReceipt })).kind).toBe('ok');
    expect(await closure.stopDelivery(request)).toMatchObject({ kind: 'stopped', receipt: {
      markerRevision: 3, activeBindingCount: 2, fencedBindings: [
        { bindingId: binding.bindingId, generation: 0 }, { bindingId: second.bindingId, generation: 0 },
      ], futureBindingAdmissionBlocked: true, modelDispatchBlocked: true,
    } });
  });
});
