import { describe, expect, it } from 'vitest';
import type { RoomId, SessionBinding } from '@khala/contracts/messaging/index';
import type { AuthService } from '../../auth/index';
import type { AdapterCapabilities } from '../../agent-bootstrap/handler';
import { createAgentBindingStore } from '../../agent-bootstrap/store';
import { createOwnerRoomIndex } from '../../agent-bootstrap/owner-room-index';
import type { AdmissionGateway } from '../../invitations/index';
import { fakeStore, T0 } from '../../auth/support.test';
import { createGateway } from '../../runtime/handler';
import { createLazyOwnerMailboxRoutes, createOwnerMailboxRoutes, OWNER_MAILBOX_COMPLETE, OWNER_MAILBOX_POLL, OWNER_MAILBOX_RESULT, OWNER_MAILBOX_SUBMIT, OWNER_REVIEW_BINDINGS } from './routes';
import { createOwnerMailbox } from './store';

const origin = 'https://khala.aiur.team';
const binding = { v: 1, bindingId: 'binding-mailbox', ownerId: 'owner-mailbox',
  agentParticipantId: 'agent-mailbox', deviceId: 'device-mailbox', harness: 'claude',
  sessionId: 'existing-session', generation: 2 } as SessionBinding;
const principal = { v: 1, ownerId: binding.ownerId, providerIssuer: 'https://id.example',
  providerSubject: 'owner-subject', verifiedEmail: 'owner@example.test', sessionExpiresAt: new Date(T0 + 60_000).toISOString() } as const;
const command = { bindingId: binding.bindingId, operationId: 'operation_123456', kind: 'controls_status', body: { bindingId: binding.bindingId } };

async function setup(options: { authUnavailable?: boolean; membershipUnavailable?: boolean;
  bindingReadUnavailable?: boolean; mailboxReadUnavailable?: boolean; authThrows?: boolean;
  bindingReadThrows?: boolean; ownerIndexReadThrows?: boolean; membershipThrows?: boolean;
  mailboxReadThrows?: boolean } = {}) {
  const state = fakeStore(() => T0);
  const bindings = createAgentBindingStore({ store: state.store });
  const address = { ownerId: binding.ownerId, roomId: '!room:example' as RoomId, agentParticipantId: binding.agentParticipantId };
  expect((await bindings.putParticipant({ ...address, expectedBindingId: null,
    record: { binding, revokedGeneration: null, capability: null } })).kind).toBe('applied');
  let signedIn = true;
  let member = true;
  let agentAuthorized = true;
  let attested = true;
  const diagnostics: Array<{ stage: string; code: string }> = [];
  const store = { ...state.store, async read(key: string) {
    if (options.bindingReadThrows && key.startsWith('agent-bootstrap:binding-index:')
      || options.ownerIndexReadThrows && key.startsWith('agent-room-index.')
      || options.mailboxReadThrows && key.startsWith('owner-mailbox')) throw new Error('secret store error');
    if (options.bindingReadUnavailable && key.startsWith('agent-bootstrap:binding-index:')
      || options.mailboxReadUnavailable && key.startsWith('owner-mailbox')) return { kind: 'unavailable' };
    return state.store.read(key);
  } } as typeof state.store;
  const auth = {
    async requireHumanMutation() { if (options.authThrows) throw new Error('secret auth error');
      return options.authUnavailable ? { kind: 'unavailable' }
      : signedIn ? { kind: 'authorized', context: { principal } } : { kind: 'rejected', code: 'signed_out' }; },
    async authenticateRequest() { return signedIn ? { kind: 'authenticated', context: { principal } } : { kind: 'signed_out' }; },
  } as unknown as AuthService;
  const gateway = { async inspectMembership() { if (options.membershipThrows) throw new Error('secret room error');
    return { kind: options.membershipUnavailable ? 'unavailable'
    : member ? 'joined' : 'absent', historyReady: false }; } } as unknown as AdmissionGateway;
  const capabilities = { async authorize() { return agentAuthorized
    ? { kind: 'authorized', binding, roomId: address.roomId, ownerId: binding.ownerId, action: 'receive_released' }
    : { kind: 'refused', status: 401, code: 'invalid_capability' }; } } as unknown as AdapterCapabilities;
  const routes = createOwnerMailboxRoutes({ auth, gateway, capabilities, store,
    clock: () => T0, authoritySecret: 'mailbox-test-secret-at-least-thirty-two-bytes',
    inspectOwnerMembership: async () => ({ kind: member ? 'joined' : 'absent' }),
    lookupAgentDevice: async () => attested
      ? { userId: '@agent:example', deviceId: binding.deviceId, fingerprint: 'A'.repeat(43) } : null,
    diagnostic: entry => diagnostics.push(entry),
  });
  const call = (path: string, method: string, body?: unknown) => {
    const route = [...routes.human, ...routes.agent].find(item => item.path === path.split('?')[0])!;
    return route.handle(new Request(`${origin}${path}${path === OWNER_MAILBOX_RESULT ? `?binding_id=${binding.bindingId}&operation_id=${command.operationId}` : ''}`,
      { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }));
  };
  return { call, routes, bindings, state, diagnostics, index: createOwnerRoomIndex(state.store), setSignedIn: (value: boolean) => { signedIn = value; },
    setMember: (value: boolean) => { member = value; }, setAgentAuthorized: (value: boolean) => { agentAuthorized = value; },
    setAttested: (value: boolean) => { attested = value; } };
}

describe('hosted owner mailbox routes', () => {
  it.each([
    [{ authUnavailable: true }, 'auth', 'session_store_unavailable'],
    [{ bindingReadUnavailable: true }, 'binding_read', 'store_unavailable'],
    [{ membershipUnavailable: true }, 'membership', 'matrix_unavailable'],
    [{ mailboxReadUnavailable: true }, 'mailbox_submit', 'store_unavailable'],
  ] as const)('reports a bounded submit failure stage for %s', async (options, stage, errorCode) => {
    const env = await setup(options);
    const response = await env.call(OWNER_MAILBOX_SUBMIT, 'POST', command);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: 'unavailable', stage, errorCode });
    expect(env.diagnostics).toEqual([{ stage, code: errorCode }]);
  });
  it('preserves the typed mailbox failure through the deployed function path', async () => {
    const env = await setup({ mailboxReadUnavailable: true });
    const route = env.routes.human.find(item => item.path === OWNER_MAILBOX_SUBMIT)!;
    const gateway = createGateway({ registrations: [route], absentPrefixes: [], appOrigin: origin });
    const response = await gateway(new Request(`${origin}/.netlify/functions/khala-control/human/owner-mailbox/submit`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(command),
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: 'unavailable', stage: 'mailbox_submit', errorCode: 'store_unavailable' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it.each([
    [{ authThrows: true }, 'auth', 'session_store_unavailable'],
    [{ bindingReadThrows: true }, 'binding_read', 'store_unavailable'],
    [{ ownerIndexReadThrows: true }, 'owner_index_read', 'store_unavailable'],
    [{ membershipThrows: true }, 'membership', 'matrix_unavailable'],
    [{ mailboxReadThrows: true }, 'mailbox_submit', 'submit_failed'],
  ] as const)('logs rejecting submit adapter %s with a safe stage through the gateway', async (options, stage, errorCode) => {
    const env = await setup(options);
    const lazy = createLazyOwnerMailboxRoutes(() => env.routes, entry => env.diagnostics.push(entry));
    const route = lazy.human.find(item => item.path === OWNER_MAILBOX_SUBMIT)!;
    const gateway = createGateway({ registrations: [route], absentPrefixes: [], appOrigin: origin });
    const response = await gateway(new Request(`${origin}/.netlify/functions/khala-control/human/owner-mailbox/submit`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(command),
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: 'unavailable', stage, errorCode });
    expect(env.diagnostics).toEqual([{ stage, code: errorCode }]);
    expect(JSON.stringify(env.diagnostics)).not.toMatch(/secret/);
  });
  it('types rejected async mailbox handlers and missing composed routes', async () => {
    const diagnostics: Array<{ stage: string; code: string }> = [];
    const rejected = createLazyOwnerMailboxRoutes(() => ({ human: [
      { path: OWNER_REVIEW_BINDINGS, methods: ['GET'], handle: async () => Response.json({}) },
      { path: OWNER_MAILBOX_SUBMIT, methods: ['POST'], handle: async () => { throw new Error('secret handler error'); } },
      { path: OWNER_MAILBOX_RESULT, methods: ['GET'], handle: async () => Response.json({}) },
    ], agent: [] }), entry => diagnostics.push(entry));
    const missing = createLazyOwnerMailboxRoutes(() => ({ human: [], agent: [] }), entry => diagnostics.push(entry));
    for (const [route, errorCode] of [[rejected.human[1]!, 'handle_failed'], [missing.human[1]!, 'route_missing']] as const) {
      const gateway = createGateway({ registrations: [route], absentPrefixes: [], appOrigin: origin });
      const response = await gateway(new Request(`${origin}/api/human/owner-mailbox/submit`, {
        method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}',
      }));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ code: 'unavailable', stage: 'composition', errorCode });
    }
    expect(diagnostics).toEqual([{ stage: 'composition', code: 'handle_failed' },
      { stage: 'composition', code: 'route_missing' }]);
  });
  it('discovers only active bindings for the authenticated room owner', async () => {
    const env = await setup();
    const route = OWNER_REVIEW_BINDINGS + '?room_id=%21room%3Aexample';
    expect((await env.call(route, 'GET')).status).toBe(200);
    expect(await (await env.call(route, 'GET')).json()).toEqual({ v: 1, roomId: '!room:example', bindings: [] });
    expect((await env.index.activate(binding, '!room:example' as RoomId)).kind).toBe('ok');
    env.setAttested(false);
    expect(await (await env.call(route, 'GET')).json()).toEqual({ v: 1, roomId: '!room:example', bindings: [
      { bindingId: binding.bindingId, generation: 2, agentParticipantId: binding.agentParticipantId, device: null },
    ] });
    env.setAttested(true);
    expect(await (await env.call(route, 'GET')).json()).toEqual({ v: 1, roomId: '!room:example', bindings: [
      { bindingId: binding.bindingId, generation: 2, agentParticipantId: binding.agentParticipantId,
        device: { userId: '@agent:example', deviceId: binding.deviceId, fingerprint: 'A'.repeat(43) } },
    ] });
    env.setMember(false);
    expect((await env.call(route, 'GET')).status).toBe(403);
    env.setMember(true);
    env.setSignedIn(false);
    expect((await env.call(route, 'GET')).status).toBe(401);
  });
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
    const pending = await (await env.call(OWNER_MAILBOX_POLL, 'GET')).json() as { closing: boolean; entries: Array<{ kind: string }> };
    expect(pending.closing).toBe(true);
    expect(pending.entries.map(item => item.kind)).toEqual(['channel_stop']);
    const receipt = { ...stop, bindingId: binding.bindingId, bindingGeneration: binding.generation,
      state: 'stopped', cleanupRequested: true };
    expect((await env.call(OWNER_MAILBOX_COMPLETE, 'POST', { bindingId: binding.bindingId,
      operationId: stop.operationId, outcome: { kind: 'stopped', receipt } })).status).toBe(200);
  });
});
