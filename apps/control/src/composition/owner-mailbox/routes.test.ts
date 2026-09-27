import { describe, expect, it } from 'vitest';
import type { RoomId, SessionBinding } from '@khala/contracts/messaging/index';
import type { AuthService } from '../../auth/index';
import type { AdapterCapabilities } from '../../agent-bootstrap/handler';
import { createAgentBindingStore } from '../../agent-bootstrap/store';
import { createOwnerRoomIndex } from '../../agent-bootstrap/owner-room-index';
import type { AdmissionGateway } from '../../invitations/index';
import { fakeStore, T0 } from '../../auth/support.test';
import { createOwnerMailboxRoutes, OWNER_MAILBOX_COMPLETE, OWNER_MAILBOX_POLL, OWNER_MAILBOX_RESULT, OWNER_MAILBOX_SUBMIT } from './routes';
import { createOwnerMailbox } from './store';

const origin = 'https://khala.aiur.team';
const binding = { v: 1, bindingId: 'binding-mailbox', ownerId: 'owner-mailbox',
  agentParticipantId: 'agent-mailbox', deviceId: 'device-mailbox', harness: 'claude',
  sessionId: 'existing-session', generation: 2 } as SessionBinding;
const principal = { v: 1, ownerId: binding.ownerId, providerIssuer: 'https://id.example',
  providerSubject: 'owner-subject', verifiedEmail: 'owner@example.test', sessionExpiresAt: new Date(T0 + 60_000).toISOString() } as const;
const command = { bindingId: binding.bindingId, operationId: 'operation_123456', kind: 'controls_status', body: { bindingId: binding.bindingId } };

async function setup() {
  const state = fakeStore(() => T0);
  const bindings = createAgentBindingStore({ store: state.store });
  const address = { ownerId: binding.ownerId, roomId: '!room:example' as RoomId, agentParticipantId: binding.agentParticipantId };
  expect((await bindings.putParticipant({ ...address, expectedBindingId: null,
    record: { binding, revokedGeneration: null, capability: null } })).kind).toBe('applied');
  let signedIn = true;
  let member = true;
  let agentAuthorized = true;
  const auth = {
    async requireHumanMutation() { return signedIn ? { kind: 'authorized', context: { principal } } : { kind: 'rejected', code: 'signed_out' }; },
    async authenticateRequest() { return signedIn ? { kind: 'authenticated', context: { principal } } : { kind: 'signed_out' }; },
  } as unknown as AuthService;
  const gateway = { async inspectMembership() { return { kind: member ? 'joined' : 'absent', historyReady: false }; } } as unknown as AdmissionGateway;
  const capabilities = { async authorize() { return agentAuthorized
    ? { kind: 'authorized', binding, roomId: address.roomId, ownerId: binding.ownerId, action: 'receive_released' }
    : { kind: 'refused', status: 401, code: 'invalid_capability' }; } } as unknown as AdapterCapabilities;
  const routes = createOwnerMailboxRoutes({ auth, gateway, capabilities, store: state.store,
    clock: () => T0, authoritySecret: 'mailbox-test-secret-at-least-thirty-two-bytes',
    inspectOwnerMembership: async () => ({ kind: member ? 'joined' : 'absent' }),
  });
  const call = (path: string, method: string, body?: unknown) => {
    const route = [...routes.human, ...routes.agent].find(item => item.path === path)!;
    return route.handle(new Request(`${origin}${path}${path === OWNER_MAILBOX_RESULT ? `?binding_id=${binding.bindingId}&operation_id=${command.operationId}` : ''}`,
      { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }));
  };
  return { call, bindings, state, index: createOwnerRoomIndex(state.store), setSignedIn: (value: boolean) => { signedIn = value; },
    setMember: (value: boolean) => { member = value; }, setAgentAuthorized: (value: boolean) => { agentAuthorized = value; } };
}

describe('hosted owner mailbox routes', () => {
  it('serves a typed command only after owner submission and current agent authority', async () => {
    const env = await setup();
    expect((await env.call(OWNER_MAILBOX_SUBMIT, 'POST', command)).status).toBe(200);
    const poll = await env.call(OWNER_MAILBOX_POLL, 'GET');
    expect(poll.status).toBe(200);
    const body = await poll.json() as { entries: Array<{ authority: { subject: string }; authorityMac?: string }> };
    expect(body.entries[0]!.authority.subject).toBe(principal.providerSubject);
    expect(body.entries[0]!.authorityMac).toBeUndefined();
    expect((await env.call(OWNER_MAILBOX_COMPLETE, 'POST', { bindingId: binding.bindingId,
      operationId: command.operationId, outcome: { ok: false, code: 'forbidden' } })).status).toBe(200);
    expect((await env.call(OWNER_MAILBOX_RESULT, 'GET')).status).toBe(200);
    expect((await (await env.call(OWNER_MAILBOX_POLL, 'GET')).json() as { entries: unknown[] }).entries).toEqual([]);
  });

  it('denies signed-out, departed, revoked and unauthenticated-agent requests', async () => {
    const env = await setup();
    env.setSignedIn(false);
    expect((await env.call(OWNER_MAILBOX_SUBMIT, 'POST', command)).status).toBe(401);
    env.setSignedIn(true);
    env.setMember(false);
    expect((await env.call(OWNER_MAILBOX_SUBMIT, 'POST', command)).status).toBe(403);
    expect((await env.call(OWNER_MAILBOX_POLL, 'GET')).status).toBe(403);
    env.setMember(true);
    env.setAgentAuthorized(false);
    expect((await env.call(OWNER_MAILBOX_POLL, 'GET')).status).toBe(401);
    env.setAgentAuthorized(true);
    expect((await env.call(OWNER_MAILBOX_SUBMIT, 'POST', command)).status).toBe(200);
    expect(await env.bindings.updateBinding(binding.bindingId, record => ({ ...record, revokedGeneration: 3 }))).toBe('applied');
    expect((await env.call(OWNER_MAILBOX_RESULT, 'GET')).status).toBe(403);
  });

  it('never stores a message body from an agent completion', async () => {
    const env = await setup();
    expect((await env.call(OWNER_MAILBOX_SUBMIT, 'POST', command)).status).toBe(200);
    expect((await env.call(OWNER_MAILBOX_COMPLETE, 'POST', { bindingId: binding.bindingId,
      operationId: command.operationId, outcome: { ok: true, body: 'pending secret' } })).status).toBe(409);
    expect((await (await env.call(OWNER_MAILBOX_RESULT, 'GET')).json() as { outcome: unknown }).outcome).toBeNull();
  });

  it('closes ordinary relay commands at the owner-room marker while permitting only the stop receipt', async () => {
    const env = await setup();
    expect((await env.index.activate(binding, '!room:example' as RoomId)).kind).toBe('ok');
    const stop = { operationId: 'close_operation_one', ownerId: binding.ownerId,
      roomId: '!room:example', expectedRoomRevision: 0 };
    const mailbox = createOwnerMailbox({ store: env.state.store, binding, roomId: stop.roomId,
      clock: () => T0, authoritySecret: 'mailbox-test-secret-at-least-thirty-two-bytes' });
    expect((await mailbox.submit({ operationId: stop.operationId, kind: 'channel_stop', body: stop }, principal)).kind).toBe('ok');
    expect((await env.index.markClosing(binding.ownerId, '!room:example' as RoomId, stop.operationId, 0)).kind).toBe('ok');
    expect((await env.call(OWNER_MAILBOX_SUBMIT, 'POST', command)).status).toBe(403);
    const pending = await (await env.call(OWNER_MAILBOX_POLL, 'GET')).json() as { entries: Array<{ kind: string }> };
    expect(pending.entries.map(item => item.kind)).toEqual(['channel_stop']);
    const receipt = { ...stop, bindingId: binding.bindingId, bindingGeneration: binding.generation,
      state: 'stopped', cleanupRequested: true };
    expect((await env.call(OWNER_MAILBOX_COMPLETE, 'POST', { bindingId: binding.bindingId,
      operationId: stop.operationId, outcome: { kind: 'stopped', receipt } })).status).toBe(200);
  });
});
