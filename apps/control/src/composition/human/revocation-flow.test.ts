import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AuthPrincipal, OwnerId, RoomId, SessionBinding } from '@khala/contracts/messaging/index';
import type { AuthService } from '../../auth/index';
import { fakeStore, T0 } from '../../auth/support.test';
import type { AdapterCapabilities } from '../../agent-bootstrap/handler';
import { createAgentBindingStore } from '../../agent-bootstrap/store';
import { createOwnerRoomIndex } from '../../agent-bootstrap/owner-room-index';
import { checkProof } from '../../agent-bootstrap/proof';
import { createCleanupProtocolPort } from './revocation-cleanup';
import { createOwnerRevocationRoutes, REVOCATION_REVOKE_PATH, REVOCATION_STATUS_PATH } from './revocation';
import { createRoomSendRoutes } from './room-send-routes';
import { senderIdFor } from './room-send-fence';

const origin = 'https://khala.aiur.team';
const ownerId = 'owner_flow' as OwnerId;
const roomId = '!flow:example' as RoomId;
const ownerUserId = `@khala_${Buffer.from(ownerId).toString('base64url')}:example`;
const agentUserId = '@khala_agent_sender:example';
const ownerDevice = { senderId: senderIdFor(ownerUserId, 'OWNER_DEVICE'), deviceId: 'OWNER_DEVICE', deviceKey: 'A'.repeat(43) };
const agentDevice = { senderId: senderIdFor(agentUserId, 'AGENT_DEVICE'), deviceId: 'AGENT_DEVICE', deviceKey: 'B'.repeat(43) };
const targetDevice = { senderId: senderIdFor('@khala_target:example', 'TARGET_DEVICE'), deviceId: 'TARGET_DEVICE', deviceKey: 'C'.repeat(43) };
const target = { v: 1, bindingId: 'binding_target', ownerId, agentParticipantId: 'agent_target',
  deviceId: targetDevice.deviceId, harness: 'claude', sessionId: 'target_session', generation: 4 } as SessionBinding;
const agent = { v: 1, bindingId: 'binding_sender', ownerId, agentParticipantId: 'agent_sender',
  deviceId: agentDevice.deviceId, harness: 'codex', sessionId: 'sender_session', generation: 1 } as SessionBinding;
const principal = { v: 1, ownerId, providerIssuer: 'https://issuer.example', providerSubject: 'owner_flow',
  verifiedEmail: 'owner@example.test', sessionExpiresAt: new Date(T0 + 60_000).toISOString() } as AuthPrincipal;

describe('owner route through the room send barrier and sender receipts', () => {
  it('requires both authenticated surviving senders before the owner operation reports rotation', async () => {
    const store = fakeStore(() => T0).store;
    const bindings = createAgentBindingStore({ store });
    const index = createOwnerRoomIndex(store);
    for (const binding of [target, agent]) {
      expect((await bindings.putParticipant({ ownerId, roomId, agentParticipantId: binding.agentParticipantId,
        expectedBindingId: null, record: { binding, revokedGeneration: null, capability: null } })).kind).toBe('applied');
      expect((await index.activate(binding, roomId)).kind).toBe('ok');
    }
    const auth = {
      async authenticateRequest() { return { kind: 'authenticated', context: { principal } }; },
      async requireHumanMutation() { return { kind: 'authorized', context: { principal } }; },
    } as unknown as AuthService;
    const privateKey = generateKeyPairSync('ed25519').privateKey;
    const publicKey = createPublicKey(privateKey).export({ format: 'jwk' }).x!;
    const signer = {
      jkt: createHash('sha256').update(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x: publicKey })).digest('base64url'),
      proof(method: string, url: string, token: string) {
        const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'dpop+jwt',
          jwk: { kty: 'OKP', crv: 'Ed25519', x: publicKey } })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({ htm: method, htu: url, iat: Math.floor(T0 / 1000),
          jti: randomBytes(16).toString('base64url'),
          ath: createHash('sha256').update(token).digest('base64url') })).toString('base64url');
        return `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')}`;
      },
    };
    const capabilityToken = 'agent-flow-capability-token';
    const seenProofs = new Set<string>();
    let removalCalls = 0;
    const capabilities = {
      async authorize(request: Request, action: string) {
        if (action !== 'publish_own' || request.headers.get('authorization') !== `DPoP ${capabilityToken}`) {
          return { kind: 'refused', status: 401, code: 'invalid_capability' };
        }
        const checked = checkProof(request.headers.get('dpop'), { method: 'POST', url: request.url,
          accessToken: capabilityToken, jkt: signer.jkt, nowMs: T0 });
        if (checked.kind !== 'valid' || seenProofs.has(checked.jti)) return { kind: 'refused', status: 401, code: 'invalid_proof' };
        seenProofs.add(checked.jti);
        const current = await bindings.locateBinding(agent.bindingId);
        return current.kind === 'found' && current.record.revokedGeneration === null
          ? { kind: 'authorized', action: 'publish_own', ownerId, roomId, binding: agent }
          : { kind: 'refused', status: 401, code: 'binding_revoked' };
      },
      async disableBinding(input: { bindingId: string; expectedGeneration: number; revokedGeneration: number }) {
        const result = await bindings.updateBinding(input.bindingId, record => record.revokedGeneration === null
          && record.binding.generation === input.expectedGeneration
          ? { ...record, revokedGeneration: input.revokedGeneration } : null);
        return { kind: result === 'applied' ? 'applied' : 'stale' };
      },
      async revokeAdapterCapability() { return { kind: 'applied' }; },
    } as unknown as AdapterCapabilities;
    const routeSet = createRoomSendRoutes({ store, auth, capabilities,
      inspectOwnerMembership: async () => ({ kind: 'joined' }),
      verifyBrowserSender: async (_, deviceId, token) => deviceId === ownerDevice.deviceId && token === 'owner-matrix-token-123456'
        ? { matrixUserId: ownerUserId, deviceKey: ownerDevice.deviceKey } : null,
      agentSender: async binding => binding.bindingId === agent.bindingId
        ? { matrixUserId: agentUserId, deviceKey: agentDevice.deviceKey } : null,
    });
    const human = async (action: string, body: Record<string, unknown>) => {
      const path = `/api/human/room-send/${action}`;
      return routeSet.find(route => route.path === path)!.handle(new Request(`${origin}${path}`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roomId, deviceId: ownerDevice.deviceId,
          matrixAccessToken: 'owner-matrix-token-123456', ...body }) }));
    };
    const agentCall = async (action: string, body: Record<string, unknown>) => {
      const path = `/api/agent/room-send/${action}`;
      const url = `${origin}${path}`;
      return routeSet.find(route => route.path === path)!.handle(new Request(url, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `DPoP ${capabilityToken}`,
          dpop: signer.proof('POST', url, capabilityToken) }, body: JSON.stringify(body) }));
    };
    expect((await human('ready', {})).status).toBe(200);
    expect((await agentCall('ready', {})).status).toBe(200);
    const ownerRoutes = createOwnerRevocationRoutes({ auth, store, capabilities,
      deviceIdentityKey: async binding => binding.bindingId === target.bindingId ? targetDevice.deviceKey : null,
      inspectOwnerMembership: async () => ({ kind: 'joined' }),
      inspectRoomSenderDevices: async () => ({ kind: 'ok', senders: [ownerDevice, agentDevice, targetDevice] }),
      protocolFor: () => createCleanupProtocolPort(store, ownerId, {
        async remove(input) { removalCalls += 1; expect(input).toMatchObject({ bindingId: target.bindingId,
          deviceId: targetDevice.deviceId, deviceKey: targetDevice.deviceKey,
          expectedGeneration: target.generation, revokedGeneration: target.generation + 1 }); return 'removed'; },
        async status() { return 'removed'; },
      }),
    });
    const operationId = 'operation_flow';
    const revokeBody = { operationId, targetKind: 'binding', targetId: target.bindingId, expectedGeneration: target.generation };
    const revoke = () => ownerRoutes.find(route => route.path === REVOCATION_REVOKE_PATH)!.handle(new Request(`${origin}${REVOCATION_REVOKE_PATH}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(revokeBody) }));
    const status = async () => (await ownerRoutes.find(route => route.path === REVOCATION_STATUS_PATH)!.handle(
      new Request(`${origin}${REVOCATION_STATUS_PATH}?operationId=${operationId}`))).json() as Promise<{
        value: { control: string; removal: string; rotation: string; endpoint: string } }>;
    const first = await revoke();
    expect(first.status).toBe(200);
    expect(removalCalls).toBe(1);
    expect(await status()).toMatchObject({ value: { control: 'disabled', removal: 'removed', rotation: 'pending', endpoint: 'pending' } });
    expect((await human('acquire', { clientTxnId: 'txn_held_owner' })).status).toBe(423);
    expect((await agentCall('acquire', { clientTxnId: 'txn_held_agent' })).status).toBe(423);
    const hold = await (await human('inspect', {})).json() as { hold: { operationId: string; epoch: number } };
    expect(hold.hold.operationId).toBe(operationId);
    expect((await human('rotation', { operationId, epoch: hold.hold.epoch })).status).toBe(200);
    expect((await revoke()).status).toBe(200);
    expect(await status()).toMatchObject({ value: { rotation: 'pending' } });
    expect((await agentCall('rotation', { operationId, epoch: hold.hold.epoch })).status).toBe(200);
    expect((await revoke()).status).toBe(200);
    expect(await status()).toMatchObject({ value: { removal: 'removed', rotation: 'rotated', endpoint: 'pending' } });
    expect((await human('acquire', { clientTxnId: 'txn_new_owner' })).status).toBe(200);
    expect((await agentCall('acquire', { clientTxnId: 'txn_new_agent' })).status).toBe(200);
    expect(removalCalls).toBe(1);
  });
});
