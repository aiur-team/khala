import { describe, expect, it } from 'vitest';
import type { CompareAndSetInput, ControlRecord, ControlStore, JsonValue, RoomId, SessionBinding } from '@khala/contracts/messaging/index';
import type { AuthService } from '../../../apps/control/src/auth/index';
import type { AdapterCapabilities } from '../../../apps/control/src/agent-bootstrap/handler';
import { createAgentBindingStore } from '../../../apps/control/src/agent-bootstrap/store';
import { createOwnerRoomIndex } from '../../../apps/control/src/agent-bootstrap/owner-room-index';
import type { AdmissionGateway } from '../../../apps/control/src/invitations/index';
import { createOwnerMailboxRoutes, OWNER_REVIEW_BINDINGS } from '../../../apps/control/src/composition/owner-mailbox/routes';
import { mintCanary } from './fixtures';

function memoryStore(): ControlStore {
  const records = new Map<string, ControlRecord>();
  let revision = 0;
  return {
    async read<T extends JsonValue>(key: string) {
      const record = records.get(key);
      return record ? { kind: 'record' as const, record: record as ControlRecord<T> } : { kind: 'absent' as const };
    },
    async compareAndSet<T extends JsonValue>(input: CompareAndSetInput<T>) {
      const current = records.get(input.key);
      if ((current?.revision ?? null) !== input.expectedRevision) {
        return { kind: 'conflict' as const, current: current as ControlRecord<T> | undefined ?? null };
      }
      const record: ControlRecord<T> = { key: input.key, revision: `r${++revision}`, operationId: input.operationId,
        value: structuredClone(input.next.value), expiresAt: input.next.expiresAt };
      records.set(input.key, record);
      return { kind: 'applied' as const, record };
    },
    async resolve() { return { kind: 'not_applied' as const }; },
  };
}

describe('hosted review binding lookup boundary', () => {
  it('exposes an attested public device only to the bound, joined owner', async () => {
    const roomId = '!review:example' as RoomId;
    const binding = { v: 1, bindingId: 'binding_review_security', ownerId: 'owner_review',
      agentParticipantId: 'agent_review', deviceId: 'agent_device', harness: 'claude',
      sessionId: 'existing-session', generation: 2 } as SessionBinding;
    const store = memoryStore();
    const bindings = createAgentBindingStore({ store });
    expect((await bindings.putParticipant({ ownerId: binding.ownerId, roomId,
      agentParticipantId: binding.agentParticipantId, expectedBindingId: null,
      record: { binding, revokedGeneration: null, capability: null } })).kind).toBe('applied');
    expect((await createOwnerRoomIndex(store).activate(binding, roomId)).kind).toBe('ok');
    const canary = mintCanary('pending');
    const owner = { ownerId: binding.ownerId, providerIssuer: 'https://issuer.example', providerSubject: 'owner-subject',
      verifiedEmail: 'owner@example.test', sessionExpiresAt: '2026-09-27T10:00:00Z' };
    const peer = { ...owner, ownerId: 'peer_owner', providerSubject: 'peer-subject' };
    let joined = true;
    const auth = { async authenticateRequest(request: Request) {
      const cookie = request.headers.get('cookie');
      return cookie === 'session=owner' ? { kind: 'authenticated', context: { principal: owner } }
        : cookie === 'session=peer' ? { kind: 'authenticated', context: { principal: peer } }
          : { kind: 'signed_out' };
    } } as unknown as AuthService;
    const gateway = { async inspectMembership() { return { kind: joined ? 'joined' : 'absent', historyReady: false }; } } as unknown as AdmissionGateway;
    const routes = createOwnerMailboxRoutes({ auth, gateway, store,
      capabilities: {} as AdapterCapabilities, clock: () => Date.parse('2026-09-27T09:00:00Z'),
      authoritySecret: 'owner-review-security-secret-at-least-thirty-two-bytes',
      inspectOwnerMembership: async () => ({ kind: 'joined' }),
      lookupAgentDevice: async () => ({ userId: '@agent:example', deviceId: binding.deviceId, fingerprint: 'A'.repeat(43) }),
    });
    const lookup = routes.human.find(route => route.path === OWNER_REVIEW_BINDINGS)!;
    const request = (query: string, cookie?: string) => lookup.handle(new Request(
      `https://khala.example${OWNER_REVIEW_BINDINGS}?${query}`,
      { headers: cookie ? { cookie } : { authorization: 'DPoP fake-agent-capability' } }));
    const own = await request('room_id=%21review%3Aexample', 'session=owner');
    expect(own.status).toBe(200);
    const body = await own.text();
    expect(body).toContain(binding.bindingId);
    expect(body).toContain('A'.repeat(43));
    expect(body).not.toContain(canary.text);
    expect((await request('room_id=%21review%3Aexample')).status).toBe(401);
    expect(await (await request('room_id=%21review%3Aexample', 'session=peer')).json())
      .toEqual({ v: 1, roomId, bindings: [] });
    expect(await (await request('room_id=%21other%3Aexample', 'session=owner')).json())
      .toEqual({ v: 1, roomId: '!other:example', bindings: [] });
    joined = false;
    expect((await request('room_id=%21review%3Aexample', 'session=owner')).status).toBe(403);
  });
});
