import { describe, expect, it } from 'vitest';
import type { AuthPrincipal, RoomId, SessionBinding } from '@khala/contracts/messaging/index';
import type { AuthService } from '../../auth/index';
import type { AdapterCapabilities } from '../../agent-bootstrap/handler';
import { fakeStore, T0 } from '../../auth/support.test';
import { createRoomSendFence, senderIdFor } from './room-send-fence';
import { createMatrixBrowserSenderVerifier, createRoomSendRoutes } from './room-send-routes';

const roomId = '!send-fence:example' as RoomId;
const origin = 'https://khala.aiur.team';
const principal = { v: 1, ownerId: 'owner_a', providerIssuer: 'https://id.example', providerSubject: 'owner_a',
  verifiedEmail: 'owner@example.test', sessionExpiresAt: new Date(T0 + 60_000).toISOString() } as AuthPrincipal;
const binding = { v: 1, bindingId: 'binding_a', ownerId: 'owner_a', agentParticipantId: 'agent_a',
  deviceId: 'agent_device', harness: 'claude', sessionId: 'session_a', generation: 3 } as SessionBinding;
const humanUser = '@khala_owner_a:example.test';
const agentUser = '@khala_agent_a:example.test';
const human = { senderId: senderIdFor(humanUser, 'browser_device'), deviceId: 'browser_device', deviceKey: 'A'.repeat(43) };
const agent = { senderId: senderIdFor(agentUser, binding.deviceId), deviceId: binding.deviceId, deviceKey: 'B'.repeat(43) };

function setup() {
  const store = fakeStore(() => T0).store;
  const fence = createRoomSendFence(store);
  let owner = principal.ownerId;
  let agentGeneration = binding.generation;
  let agentKey = agent.deviceKey;
  const routes = createRoomSendRoutes({ store,
    auth: { async requireHumanMutation() { return { kind: 'authorized', context: { principal: { ...principal, ownerId: owner } } }; } } as unknown as AuthService,
    capabilities: { async authorize(_request, action) {
      return action === 'publish_own' && agentGeneration === binding.generation
        ? { kind: 'authorized', action, ownerId: binding.ownerId, roomId, binding }
        : { kind: 'refused', status: 401, code: 'binding_superseded' };
    } } as AdapterCapabilities,
    inspectOwnerMembership: async ownerId => ({ kind: ownerId === principal.ownerId ? 'joined' : 'absent' }),
    verifyBrowserSender: async (identity, deviceId, token) => identity.ownerId === principal.ownerId
      && deviceId === human.deviceId && token === 'valid-browser-token-123456789'
      ? { matrixUserId: humanUser, deviceKey: human.deviceKey } : null,
    agentSender: async () => ({ matrixUserId: agentUser, deviceKey: agentKey }),
  });
  async function call(kind: 'human' | 'agent', action: string, extra: Record<string, unknown> = {}) {
    const route = routes.find(item => item.path === `/api/${kind}/room-send/${action}`)!;
    const base = kind === 'human' ? { roomId, deviceId: human.deviceId,
      matrixAccessToken: 'valid-browser-token-123456789' } : {};
    return route.handle(new Request(`${origin}${route.path}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...base, ...extra }) }));
  }
  return { fence, call, setOwner: (value: string) => { owner = value as typeof owner; },
    setAgentGeneration: (value: number) => { agentGeneration = value; },
    setAgentKey: (value: string) => { agentKey = value; } };
}

describe('authenticated room send fence routes', () => {
  it('verifies the transient browser Matrix token and exact published Curve25519 device key', async () => {
    const userId = `@khala_${Buffer.from(principal.ownerId, 'utf8').toString('base64url')}:example.test`;
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: 'Bearer valid-browser-token-123456789' });
      return Response.json(String(url).endsWith('/account/whoami')
        ? { user_id: userId, device_id: human.deviceId }
        : { device_keys: { [userId]: { [human.deviceId]: { user_id: userId, device_id: human.deviceId,
          keys: { [`curve25519:${human.deviceId}`]: human.deviceKey } } } } });
    };
    const verify = createMatrixBrowserSenderVerifier({ homeserverOrigin: 'https://matrix.example.test',
      serverName: 'example.test', fetch: fetch as typeof globalThis.fetch });
    expect(await verify(principal, human.deviceId, 'valid-browser-token-123456789'))
      .toEqual({ matrixUserId: userId, deviceKey: human.deviceKey });
    expect(await verify(principal, 'other_device', 'valid-browser-token-123456789')).toBeNull();
  });
  it('binds permits and completions to exact owner/agent devices and serializes a hold', async () => {
    const h = setup();
    expect((await h.call('human', 'ready')).status).toBe(200);
    expect((await h.call('agent', 'ready')).status).toBe(200);
    expect(await h.fence.seedRoster(roomId, [human, agent])).toBe('applied');
    const result = await h.call('human', 'acquire', { clientTxnId: 'txn_a' });
    expect(result.status).toBe(200);
    const granted = await result.json() as { permitId: string };
    expect(await h.fence.beginHold(roomId, 'operation_a', 'C'.repeat(43))).toBe('held');
    expect((await h.call('agent', 'acquire', { clientTxnId: 'txn_b' })).status).toBe(423);
    expect(await h.fence.drained(roomId, 'operation_a')).toBe('pending');
    expect((await h.call('agent', 'finish', { permitId: granted.permitId, outcome: 'complete',
      eventId: '$wrong:example' })).status).toBe(503);
    expect((await h.call('human', 'finish', { permitId: granted.permitId, outcome: 'complete',
      eventId: '$right:example' })).status).toBe(200);
    expect(await h.fence.drained(roomId, 'operation_a')).toBe('drained');
    expect((await h.call('human', 'rotation', { operationId: 'operation_a', epoch: 1 })).status).toBe(200);
    expect(await h.fence.rotationStatus(roomId, 'operation_a')).toBe('pending');
    expect((await h.call('agent', 'rotation', { operationId: 'operation_a', epoch: 1 })).status).toBe(200);
    expect(await h.fence.rotationStatus(roomId, 'operation_a')).toBe('rotated');
  });

  it('rejects wrong owner, stale agent generation and changed published identity key', async () => {
    const h = setup();
    h.setOwner('other_owner');
    expect((await h.call('human', 'ready')).status).toBe(403);
    h.setAgentGeneration(4);
    expect((await h.call('agent', 'ready')).status).toBe(401);
    h.setAgentGeneration(3);
    await h.call('agent', 'ready');
    h.setAgentKey('D'.repeat(43));
    expect((await h.call('agent', 'ready')).status).toBe(503);
  });
});
