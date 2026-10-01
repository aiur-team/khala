import { describe, expect, it, vi } from 'vitest';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import { createAgentParticipantLookup } from './participant-directory';

const binding = { v: 1, bindingId: 'binding_mira', ownerId: 'owner_mira', agentParticipantId: 'agent_mira',
  deviceId: 'device_mira', harness: 'codex', sessionId: 'session_mira', generation: 1 } as SessionBinding;

describe('agent participant lookup', () => {
  it('keeps the room, proof and returned identities bound to the admitted agent', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      expect(init?.body).toBe(JSON.stringify({ roomId: '!room:matrix.test', userIds: ['@agent:matrix.test'],
        targetParticipantIds: ['agent_departed'] }));
      expect(new Headers(init?.headers).get('origin')).toBe('https://khala.example');
      expect(new Headers(init?.headers).get('authorization')).toBe('DPoP capability');
      expect(new Headers(init?.headers).get('dpop')).toBe('signed-proof');
      expect(new Headers(init?.headers).get('origin')).toBe('https://khala.example');
      return new Response(JSON.stringify({ participants: [{ matrixUserId: '@agent:matrix.test',
        participantId: 'agent_mira', ownerId: 'owner_mira', displayName: 'Codex #mira', kind: 'agent',
        deviceId: 'device_mira', fingerprint: 'A'.repeat(43) },
      { matrixUserId: '@departed:matrix.test', participantId: 'agent_departed', ownerId: 'owner_mira',
        displayName: 'Codex #old', kind: 'agent' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const lookup = createAgentParticipantLookup({ appOrigin: 'https://khala.example', binding,
      roomId: '!room:matrix.test', signer: { proof: () => 'signed-proof' } as never,
      capability: async () => ({ token: 'capability', bindingId: binding.bindingId,
        generation: binding.generation, scope: ['receive_released'], expiresAt: Date.now() + 60_000 }) as never,
      fetch });
    const participants = await lookup(['@agent:matrix.test'], ['agent_departed']);
    expect(participants?.get('@agent:matrix.test'))
      .toEqual({ participantId: 'agent_mira', ownerId: 'owner_mira', kind: 'agent', initialName: 'Codex #mira',
        deviceId: 'device_mira', fingerprint: 'A'.repeat(43) });
    expect(participants?.get('@departed:matrix.test')?.participantId).toBe('agent_departed');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects an incomplete device pin', async () => {
    const lookup = createAgentParticipantLookup({ appOrigin: 'https://khala.example', binding,
      roomId: '!room:matrix.test', signer: { proof: () => 'signed-proof' } as never,
      capability: async () => ({ token: 'capability', bindingId: binding.bindingId,
        generation: binding.generation, scope: ['receive_released'], expiresAt: Date.now() + 60_000 }) as never,
      fetch: async () => new Response(JSON.stringify({ participants: [{ matrixUserId: '@agent:matrix.test',
        participantId: 'agent_mira', ownerId: 'owner_mira', displayName: 'Codex #mira', kind: 'agent',
        deviceId: 'device_mira' }] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    expect(await lookup(['@agent:matrix.test'])).toBeNull();
  });
});
