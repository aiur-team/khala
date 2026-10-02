import { describe, expect, it, vi } from 'vitest';
import type { ParticipantId, RoomId, SessionBinding } from '@khala/contracts/messaging/index';
import type { AdapterCapabilities } from '../../agent-bootstrap/handler';
import { createAgentBindingStore } from '../../agent-bootstrap/store';
import { fakeStore, T0 } from '../../auth/support.test';
import { createAgentParticipantDirectoryRoute } from './participant-directory';
import { createAgentIdentityDirectory } from './identity-directory';

const roomId = '!agents:matrix.example.test' as RoomId;
const binding = { v: 1, bindingId: 'binding_directory', ownerId: 'owner_mira', agentParticipantId: 'agent_mira',
  deviceId: 'device_mira', harness: 'codex', sessionId: 'session_mira', generation: 1 } as SessionBinding;

describe('agent participant directory', () => {
  it('serves only the active binding and its exact room', async () => {
    const state = fakeStore(() => T0);
    const bindings = createAgentBindingStore({ store: state.store });
    expect((await bindings.putParticipant({ ownerId: binding.ownerId, roomId,
      agentParticipantId: binding.agentParticipantId, expectedBindingId: null,
      record: { binding, revokedGeneration: null, capability: 'a'.repeat(43) } })).kind).toBe('applied');
    expect(await createAgentIdentityDirectory(state.store).remember({ v: 1, roomId,
      matrixUserId: '@departed:matrix.example.test', participantId: 'agent_departed' as ParticipantId,
      ownerId: binding.ownerId, harness: 'codex' })).toBe(true);
    let active = true;
    const capabilities = { async authorize() { return { kind: 'authorized', ownerId: binding.ownerId, roomId,
      binding, action: 'receive_released' }; }, async lookupBinding() { return { kind: 'found',
        ownerId: binding.ownerId, generation: binding.generation, deviceId: binding.deviceId,
        status: active ? 'active' : 'revoked' }; } } as unknown as AdapterCapabilities;
    const resolveRoomParticipants = vi.fn(async () => ({ kind: 'ok' as const, participants: [{
      matrixUserId: '@khala_a_x:matrix.example.test', participantId: binding.agentParticipantId,
      ownerId: binding.ownerId, displayName: 'Codex #mira', kind: 'agent' as const, ownerLabel: 'Owner', harness: 'codex' as const,
    }] }));
    let pinState: 'found' | 'absent' | 'unavailable' = 'found';
    const route = createAgentParticipantDirectoryRoute({ store: state.store, capabilities,
      sessions: { resolveRoomParticipants }, lookupAgentDevice: async () => pinState === 'found' ? ({
        kind: 'found', deviceId: binding.deviceId, fingerprint: 'A'.repeat(43),
      }) : { kind: pinState } });
    const request = (room: string) => new Request('https://khala.example' + route.path, { method: 'POST',
      body: JSON.stringify({ roomId: room, userIds: ['@khala_a_x:matrix.example.test'],
        targetParticipantIds: ['agent_departed'] }) });
    const response = await route.handle(request(roomId));
    expect(response.status).toBe(200);
    expect((await response.json() as { participants: unknown }).participants).toEqual(expect.arrayContaining([
      expect.objectContaining({ participantId: 'agent_departed', matrixUserId: '@departed:matrix.example.test' }),
      expect.objectContaining({ participantId: binding.agentParticipantId, deviceId: binding.deviceId,
        fingerprint: 'A'.repeat(43) }),
    ]));
    expect(resolveRoomParticipants).toHaveBeenCalledWith(binding.ownerId, roomId, ['@khala_a_x:matrix.example.test']);
    expect((await route.handle(request('!other:matrix.example.test'))).status).toBe(403);
    pinState = 'absent';
    const unpinned = await route.handle(request(roomId));
    expect(unpinned.status).toBe(200);
    expect((await unpinned.json() as { participants: unknown[] }).participants).toEqual(expect.arrayContaining([
      expect.objectContaining({ participantId: binding.agentParticipantId }),
    ]));
    pinState = 'unavailable';
    expect((await route.handle(request(roomId))).status).toBe(503);
    pinState = 'found';
    active = false;
    expect((await route.handle(request(roomId))).status).toBe(403);
    expect(resolveRoomParticipants).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['approved', 'active', true, null, 'device_peer', true],
    ['unapproved', 'active', false, null, 'device_peer', false],
    ['revoked record', 'active', true, null, 'device_peer', false],
    ['revoked', 'revoked', true, null, 'device_peer', false],
    ['stale generation', 'active', true, 2, 'device_peer', false],
    ['wrong device', 'active', true, null, 'other_device', false],
  ] as const)('pins only a current %s peer session', async (_case, status, approved, generation, deviceId, expectedPin) => {
    const state = fakeStore(() => T0);
    const bindings = createAgentBindingStore({ store: state.store });
    const peerBinding = { ...binding, bindingId: 'binding_peer', agentParticipantId: 'agent_peer',
      deviceId: 'device_peer', sessionId: 'session_peer' } as SessionBinding;
    for (const item of [binding, peerBinding]) {
      expect((await bindings.putParticipant({ ownerId: item.ownerId, roomId,
        agentParticipantId: item.agentParticipantId, expectedBindingId: null,
        record: { binding: item, revokedGeneration: item === peerBinding && _case === 'revoked record' ? 2 : null,
          capability: item === peerBinding && !approved ? null : 'a'.repeat(43) } })).kind).toBe('applied');
    }
    const lookupAgentDevice = vi.fn(async () => ({ kind: 'found' as const,
      deviceId: peerBinding.deviceId, fingerprint: 'A'.repeat(43) }));
    const route = createAgentParticipantDirectoryRoute({ store: state.store,
      capabilities: { async authorize() { return { kind: 'authorized', ownerId: binding.ownerId, roomId,
        binding, action: 'receive_released' }; }, async lookupBinding(id: string) {
        return { kind: 'found', ownerId: binding.ownerId,
          generation: id === peerBinding.bindingId ? generation ?? peerBinding.generation : binding.generation,
          deviceId: id === peerBinding.bindingId ? deviceId : binding.deviceId,
          status: id === peerBinding.bindingId ? status : 'active' };
      } } as unknown as AdapterCapabilities,
      sessions: { resolveRoomParticipants: async () => ({ kind: 'ok', participants: [{
        matrixUserId: '@peer:matrix.example.test', participantId: peerBinding.agentParticipantId,
        ownerId: peerBinding.ownerId, displayName: 'Peer', kind: 'agent' as const, ownerLabel: 'Owner', harness: 'codex' as const,
      }] }) }, lookupAgentDevice });
    const response = await route.handle(new Request('https://khala.example' + route.path, { method: 'POST',
      body: JSON.stringify({ roomId, userIds: ['@peer:matrix.example.test'], targetParticipantIds: [] }) }));
    expect(response.status).toBe(200);
    const peer = (await response.json() as { participants: Record<string, unknown>[] }).participants[0];
    expect(peer).toMatchObject({ matrixUserId: '@peer:matrix.example.test' });
    if (expectedPin) expect(peer).toMatchObject({ deviceId: 'device_peer', fingerprint: 'A'.repeat(43) });
    else expect(peer).not.toHaveProperty('deviceId');
    expect(lookupAgentDevice).toHaveBeenCalledTimes(expectedPin ? 1 : 0);
  });
});
