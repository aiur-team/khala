import { describe, expect, it } from 'vitest';
import type { AuthPrincipal, RoomId, SessionBinding } from '@khala/contracts/messaging/index';
import type { AuthService } from '../../auth/index';
import type { AdapterCapabilities } from '../../agent-bootstrap/handler';
import { createAgentBindingStore } from '../../agent-bootstrap/store';
import { createOwnerRoomIndex } from '../../agent-bootstrap/owner-room-index';
import { fakeStore, T0 } from '../../auth/support.test';
import { createOwnerRevocationRoutes, REVOCATION_REVOKE_PATH, REVOCATION_STATUS_PATH, REVOCATION_TARGETS_PATH } from './revocation';
import { createRoomSendFence } from './room-send-fence';

const origin = 'https://khala.aiur.team';
const roomId = '!revocation:example' as RoomId;
const binding = { v: 1, bindingId: 'binding-revoke', ownerId: 'owner-revoke', agentParticipantId: 'agent-revoke',
  deviceId: 'device-revoke', harness: 'claude', sessionId: 'session-revoke', generation: 2 } as SessionBinding;
const person = (ownerId: string) => ({ v: 1, ownerId, providerIssuer: 'https://id.example',
  providerSubject: ownerId, verifiedEmail: `${ownerId}@example.test`, sessionExpiresAt: new Date(T0 + 60_000).toISOString() }) as AuthPrincipal;

async function setup() {
  const state = fakeStore(() => T0);
  const bindings = createAgentBindingStore({ store: state.store });
  await bindings.putParticipant({ ownerId: binding.ownerId, roomId, agentParticipantId: binding.agentParticipantId,
    expectedBindingId: null, record: { binding, revokedGeneration: null, capability: null } });
  await createOwnerRoomIndex(state.store).activate(binding, roomId);
  let owner = person(binding.ownerId);
  let member = true;
  let key: string | null = 'B'.repeat(43);
  const effects: string[] = [];
  const auth = {
    async authenticateRequest() { return { kind: 'authenticated', context: { principal: owner } }; },
    async requireHumanMutation() { return { kind: 'authorized', context: { principal: owner } }; },
  } as unknown as AuthService;
  const capabilities = {
    async disableBinding(input: { bindingId: string; expectedGeneration: number; revokedGeneration: number }) {
      effects.push('disable');
      const result = await bindings.updateBinding(input.bindingId, record => record.revokedGeneration === null
        && record.binding.generation === input.expectedGeneration ? { ...record, revokedGeneration: input.revokedGeneration } : null);
      return { kind: result === 'applied' ? 'applied' : 'stale' };
    },
    async revokeAdapterCapability() { effects.push('capability'); return { kind: 'applied' }; },
  } as unknown as AdapterCapabilities;
  const routes = createOwnerRevocationRoutes({ auth, store: state.store, capabilities,
    deviceIdentityKey: async () => key,
    inspectOwnerMembership: async () => ({ kind: member ? 'joined' : 'absent' }),
    inspectRoomSenderDevices: async () => ({ kind: 'ok', senders: [
      { senderId: 'owner_device_A', deviceId: 'device_A', deviceKey: 'A'.repeat(43) },
    ] }),
    protocolFor: () => ({
      async removeDevice() { effects.push('remove'); return { kind: 'refused', reason: 'reauthentication_required' }; },
      async deviceStatus() { effects.push('status'); return { kind: 'present' }; },
      async rotateSessions() { effects.push('rotate'); return { kind: 'unavailable' }; },
    }),
  });
  const sendFence = createRoomSendFence(state.store);
  const seeded = { senderId: 'owner_device_A', deviceId: 'device_A', deviceKey: 'A'.repeat(43) };
  await sendFence.readySender(roomId, seeded);
  await sendFence.seedRoster(roomId, [seeded]);
  const call = (path: string, method: 'GET' | 'POST', body?: unknown) => {
    const selected = routes.find(route => route.path === path)!;
    const url = path === REVOCATION_TARGETS_PATH ? `${origin}${path}?roomId=${encodeURIComponent(roomId)}`
      : path === REVOCATION_STATUS_PATH ? `${origin}${path}?operationId=operation_123456` : `${origin}${path}`;
    return selected.handle(new Request(url, { method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }));
  };
  const request = { operationId: 'operation_123456', targetKind: 'binding', targetId: binding.bindingId, expectedGeneration: 2 };
  return { call, request, effects, bindings, sendFence,
    setOwner(value: string) { owner = person(value); },
    setMember(value: boolean) { member = value; },
    setKey(value: string | null) { key = value; },
  };
}

describe('owner revocation routes', () => {
  it('lists only current owner targets and preserves a protocol refusal as partial progress', async () => {
    const h = await setup();
    expect(await (await h.call(REVOCATION_TARGETS_PATH, 'GET')).json()).toEqual({ targets: [
      { targetKind: 'binding', targetId: binding.bindingId, expectedGeneration: 2 },
    ] });
    const result = await h.call(REVOCATION_REVOKE_PATH, 'POST', h.request);
    expect(result.status).toBe(200);
    expect((await result.json() as { value: { state: string } }).value.state).toBe('partial');
    expect(h.effects).toEqual(['disable', 'capability', 'remove']);
    const status = await h.call(REVOCATION_STATUS_PATH, 'GET');
    expect(status.status).toBe(200);
    expect((await status.json() as { value: { removal: string; rotation: string; endpoint: string } }).value)
      .toMatchObject({ removal: 'refused', rotation: 'pending', endpoint: 'pending' });
  });

  it('refuses wrong owner, departed owner, stale generation and unavailable exact device key before effects', async () => {
    const h = await setup();
    h.setOwner('other-owner');
    expect((await h.call(REVOCATION_REVOKE_PATH, 'POST', h.request)).status).toBe(404);
    h.setOwner(binding.ownerId);
    h.setMember(false);
    expect((await h.call(REVOCATION_REVOKE_PATH, 'POST', h.request)).status).toBe(404);
    h.setMember(true);
    expect((await h.call(REVOCATION_REVOKE_PATH, 'POST', { ...h.request, expectedGeneration: 1 })).status).toBe(409);
    h.setKey(null);
    expect((await h.call(REVOCATION_REVOKE_PATH, 'POST', h.request)).status).toBe(503);
    expect(h.effects).toEqual([]);
  });

  it('keeps the protocol untouched while an already-permitted Matrix transaction is unresolved', async () => {
    const h = await setup();
    const sender = { senderId: 'owner_device_A', deviceId: 'device_A', deviceKey: 'A'.repeat(43) };
    const permit = await h.sendFence.acquire(roomId, sender, 'txn_pending');
    expect(permit.kind).toBe('granted');
    if (permit.kind !== 'granted') return;
    const response = await h.call(REVOCATION_REVOKE_PATH, 'POST', h.request);
    expect(response.status).toBe(200);
    expect(h.effects).toEqual([]);
    expect(await h.sendFence.acquire(roomId, sender, 'txn_after_hold')).toMatchObject({ kind: 'held' });
    expect(await h.sendFence.finish(roomId, sender.senderId, permit.permitId, { kind: 'unknown' })).toBe('applied');
    await h.call(REVOCATION_REVOKE_PATH, 'POST', h.request);
    expect(h.effects).toEqual([]);
    expect(await h.sendFence.finish(roomId, sender.senderId, permit.permitId,
      { kind: 'complete', eventId: '$resolved:example' })).toBe('applied');
    await h.call(REVOCATION_REVOKE_PATH, 'POST', h.request);
    expect(h.effects).toEqual(['disable', 'capability', 'remove']);
  });
});
