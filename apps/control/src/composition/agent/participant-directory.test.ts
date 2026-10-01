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
      record: { binding, revokedGeneration: null, capability: null } })).kind).toBe('applied');
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
      ownerId: binding.ownerId, displayName: 'Codex #mira', kind: 'agent' as const,
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
});
