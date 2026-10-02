import { describe, expect, it } from 'vitest';
import type { AuthPrincipal, RoomId, SessionBinding } from '@khala/contracts/messaging/index';
import type { AuthService } from '../../auth/index';
import type { AdapterCapabilities } from '../../agent-bootstrap/handler';
import { createOwnerRoomIndex } from '../../agent-bootstrap/owner-room-index';
import { fakeStore, T0 } from '../../auth/support.test';
import { createGateway } from '../../runtime/handler';
import { createRoomSendFence, senderIdFor } from './room-send-fence';
import { createLazyRoomSendRoutes, createRoomSendRoutes } from './room-send-routes';

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

function setup(options: { authUnavailable?: boolean; membershipUnavailable?: boolean; storeUnavailable?: boolean;
  authThrows?: boolean; membershipThrows?: boolean; senderThrows?: boolean; storeThrows?: boolean } = {}) {
  const underlying = fakeStore(() => T0).store;
  const store = options.storeUnavailable || options.storeThrows ? { ...underlying, read: async () => {
    if (options.storeThrows) throw new Error('secret store error');
    return { kind: 'unavailable' as const };
  } } : underlying;
  const fence = createRoomSendFence(store);
  const admission = options.storeUnavailable || options.storeThrows
    ? Promise.resolve() : createOwnerRoomIndex(store).activate(binding, roomId);
  const diagnostics: Array<{ stage: string; code: string }> = [];
  let owner = principal.ownerId;
  let ownerJoined = true;
  let agentGeneration = binding.generation;
  let agentKey = agent.deviceKey;
  const routes = createRoomSendRoutes({ store,
    auth: { async requireHumanMutation() { if (options.authThrows) throw new Error('secret auth error');
      return options.authUnavailable ? { kind: 'unavailable' }
      : { kind: 'authorized', context: { principal: { ...principal, ownerId: owner } } }; } } as unknown as AuthService,
    capabilities: { async authorize(_request, action) {
      return action === 'publish_own' && agentGeneration === binding.generation
        ? { kind: 'authorized', action, ownerId: binding.ownerId, roomId, binding }
        : { kind: 'refused', status: 401, code: 'binding_superseded' };
    } } as AdapterCapabilities,
    inspectOwnerMembership: async ownerId => { if (options.membershipThrows) throw new Error('secret room error');
      return { kind: options.membershipUnavailable ? 'unavailable'
        : ownerJoined && ownerId === principal.ownerId ? 'joined' : 'absent' }; },
    verifyBrowserSender: async (identity, deviceId, token) => { if (options.senderThrows) throw new Error('secret token error');
      return identity.ownerId === principal.ownerId
      && deviceId === human.deviceId && token === 'valid-browser-token-123456789'
      ? { matrixUserId: humanUser, deviceKey: human.deviceKey } : null; },
    agentSender: async () => ({ matrixUserId: agentUser, deviceKey: agentKey }),
    diagnostic: entry => diagnostics.push(entry),
  });
  async function call(kind: 'human' | 'agent', action: string, extra: Record<string, unknown> = {}) {
    if (kind === 'agent') await admission;
    const route = routes.find(item => item.path === `/api/${kind}/room-send/${action}`)!;
    const base = kind === 'human' ? { roomId, deviceId: human.deviceId,
      matrixAccessToken: 'valid-browser-token-123456789' } : {};
    return route.handle(new Request(`${origin}${route.path}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...base, ...extra }) }));
  }
  return { fence, call, routes, diagnostics, admission,
    markClosing: () => createOwnerRoomIndex(store).markClosing(binding.ownerId, roomId, 'stop_operation', 0),
    setOwnerJoined: (value: boolean) => { ownerJoined = value; },
    setOwner: (value: string) => { owner = value as typeof owner; },
    setAgentGeneration: (value: number) => { agentGeneration = value; },
    setAgentKey: (value: string) => { agentKey = value; } };
}

describe('authenticated room send fence routes', () => {
  it('returns the recorded event for a repeated completed human transaction', async () => {
    const h = setup();
    expect((await h.call('human', 'ready')).status).toBe(200);
    const first = await h.call('human', 'acquire', { clientTxnId: 'txn_completed' });
    expect(first.status).toBe(200);
    const permit = await first.json() as { permitId: string };
    expect((await h.call('human', 'finish', { permitId: permit.permitId,
      outcome: 'complete', eventId: '$sent:example' })).status).toBe(200);
    const replay = await h.call('human', 'acquire', { clientTxnId: 'txn_completed' });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ kind: 'complete', eventId: '$sent:example' });
  });
  it('denies new agent permits after owner Stop while allowing completion of an existing permit', async () => {
    const h = setup();
    expect((await h.call('agent', 'ready')).status).toBe(200);
    const before = await h.call('agent', 'acquire', { clientTxnId: 'txn_before_stop' });
    expect(before.status).toBe(200);
    const permit = await before.json() as { permitId: string; attempt: number };
    expect((await h.markClosing()).kind).toBe('ok');
    const gateway = createGateway({ registrations: createLazyRoomSendRoutes(() => h.routes),
      absentPrefixes: [], appOrigin: origin });
    const after = await gateway(new Request(`${origin}/.netlify/functions/khala-control/agent/room-send/acquire`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ clientTxnId: 'txn_after_stop' }),
    }));
    expect(after.status).toBe(403);
    expect(await after.json()).toEqual({ code: 'channel_closing' });
    expect((await h.call('agent', 'finish', { permitId: permit.permitId, attempt: permit.attempt,
      outcome: 'cancelled', eventId: null })).status).toBe(200);
  });

  it('denies agent permits after the owner departs', async () => {
    const h = setup();
    expect((await h.call('agent', 'ready')).status).toBe(200);
    h.setOwnerJoined(false);
    const response = await h.call('agent', 'acquire', { clientTxnId: 'txn_departed' });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: 'owner_membership_required' });
  });

  it('fences a delayed finish from a cancelled agent attempt after the same transaction reacquires', async () => {
    const h = setup();
    expect((await h.call('agent', 'ready')).status).toBe(200);
    const first = await (await h.call('agent', 'acquire', { clientTxnId: 'txn_reopened' })).json() as {
      permitId: string; attempt: number;
    };
    expect((await h.call('agent', 'finish', { permitId: first.permitId, attempt: first.attempt,
      outcome: 'cancelled', eventId: null })).status).toBe(200);
    const second = await (await h.call('agent', 'acquire', { clientTxnId: 'txn_reopened' })).json() as {
      permitId: string; attempt: number;
    };
    expect(second).toMatchObject({ permitId: first.permitId, attempt: first.attempt + 1 });
    expect((await h.call('agent', 'finish', { permitId: first.permitId, attempt: first.attempt,
      outcome: 'cancelled', eventId: null })).status).toBe(503);
    expect(await h.fence.seedRoster(roomId, [agent])).toBe('applied');
    expect(await h.fence.beginHold(roomId, 'operation_overlap', 'C'.repeat(43))).toBe('held');
    expect(await h.fence.drained(roomId, 'operation_overlap')).toBe('pending');
    expect((await h.call('agent', 'finish', { permitId: second.permitId, attempt: second.attempt,
      outcome: 'cancelled', eventId: null })).status).toBe(200);
    expect(await h.fence.drained(roomId, 'operation_overlap')).toBe('drained');
  });
  it.each([
    [{ authUnavailable: true }, 'auth', 'session_store_unavailable'],
    [{ membershipUnavailable: true }, 'membership', 'matrix_unavailable'],
    [{ storeUnavailable: true }, 'fence_acquire', 'fence_unavailable'],
  ] as const)('reports a bounded acquire failure stage for %s', async (options, stage, code) => {
    const h = setup(options);
    const response = await h.call('human', 'acquire', { clientTxnId: 'txn_safe' });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ kind: 'unavailable', stage, code });
    expect(h.diagnostics).toEqual([{ stage, code }]);
  });
  it('keeps the typed fence failure through the deployed function path and origin check', async () => {
    const h = setup({ storeUnavailable: true });
    const route = h.routes.find(item => item.path === '/api/human/room-send/acquire')!;
    const gateway = createGateway({ registrations: [route], absentPrefixes: [], appOrigin: origin });
    const response = await gateway(new Request(`${origin}/.netlify/functions/khala-control/human/room-send/acquire`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ roomId, deviceId: human.deviceId, matrixAccessToken: 'valid-browser-token-123456789', clientTxnId: 'txn_safe' }),
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ kind: 'unavailable', stage: 'fence_acquire', code: 'fence_unavailable' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it.each([
    [{ authThrows: true }, 'auth', 'session_store_unavailable'],
    [{ membershipThrows: true }, 'membership', 'matrix_unavailable'],
    [{ senderThrows: true }, 'sender', 'sender_verification_unavailable'],
    [{ storeThrows: true }, 'fence_acquire', 'fence_unavailable'],
  ] as const)('logs rejecting acquire adapter %s with a safe stage through the gateway', async (options, stage, code) => {
    const h = setup(options);
    const lazy = createLazyRoomSendRoutes(() => h.routes, entry => h.diagnostics.push(entry));
    const route = lazy.find(item => item.path === '/api/human/room-send/acquire')!;
    const gateway = createGateway({ registrations: [route], absentPrefixes: [], appOrigin: origin });
    const response = await gateway(new Request(`${origin}/.netlify/functions/khala-control/human/room-send/acquire`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ roomId, deviceId: human.deviceId, matrixAccessToken: 'valid-browser-token-123456789', clientTxnId: 'txn_safe' }),
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ kind: 'unavailable', stage, code });
    expect(h.diagnostics).toEqual([{ stage, code }]);
    expect(JSON.stringify(h.diagnostics)).not.toMatch(/secret/);
  });
  it('types rejected async route handlers and a missing composed route', async () => {
    const diagnostics: Array<{ stage: string; code: string }> = [];
    const rejected = createLazyRoomSendRoutes(() => [{ path: '/api/human/room-send/acquire', methods: ['POST'],
      handle: async () => { throw new Error('secret handler error'); } }], entry => diagnostics.push(entry));
    const missing = createLazyRoomSendRoutes(() => [], entry => diagnostics.push(entry));
    for (const [route, code] of [[rejected[1]!, 'handle_failed'], [missing[1]!, 'route_missing']] as const) {
      const gateway = createGateway({ registrations: [route], absentPrefixes: [], appOrigin: origin });
      const response = await gateway(new Request(`${origin}/api/human/room-send/acquire`, {
        method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}',
      }));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ kind: 'unavailable', stage: 'composition', code });
    }
    expect(diagnostics).toEqual([{ stage: 'composition', code: 'handle_failed' },
      { stage: 'composition', code: 'route_missing' }]);
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
    expect((await h.call('agent', 'finish', { permitId: granted.permitId, attempt: 0, outcome: 'complete',
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
