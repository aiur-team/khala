import { describe, expect, it } from 'vitest';
import type { RoomId, SessionBinding } from '@khala/contracts/messaging/index';
import type { AuthService } from '../../auth/index';
import type { AdapterCapabilities } from '../../agent-bootstrap/handler';
import { createAgentBindingStore } from '../../agent-bootstrap/store';
import { createOwnerRoomIndex } from '../../agent-bootstrap/owner-room-index';
import type { AdmissionGateway } from '../../invitations/index';
import { fakeStore, T0 } from '../../auth/support.test';
import { createGateway } from '../../runtime/handler';
import { createLazyOwnerMailboxRoutes, createOwnerMailboxRoutes, OWNER_MAILBOX_COMPLETE, OWNER_MAILBOX_POLL, OWNER_MAILBOX_RESULT, OWNER_MAILBOX_SUBMIT, OWNER_REVIEW_BINDINGS, OWNER_REVIEW_STATUS } from './routes';
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
  it('accepts a grant only for the signed-in owner and exact binding generation', async () => {
    const env = await setup();
    const grant = { v: 1, kind: 'grant_experimental_route', commandId: 'grant_command_12345678',
      bindingId: binding.bindingId, expectedBindingGeneration: binding.generation,
      expectedVersion: 1, mode: 'steer', route: 'codex-steer', harnessVersion: '0.154.0',
      evidenceRevision: 'proof-1', issuedAt: '2026-09-27T00:00:00Z' };
    const submit = (body: unknown) => env.call(OWNER_MAILBOX_SUBMIT, 'POST', {
      bindingId: binding.bindingId, operationId: grant.commandId, kind: 'listening_grant', body,
    });
    expect((await submit({ ...grant, expectedBindingGeneration: binding.generation + 1 })).status).toBe(409);
    expect((await submit({ ...grant, bindingId: 'other-binding' })).status).toBe(409);
    env.setSignedIn(false);
    expect((await submit(grant)).status).toBe(401);
    env.setSignedIn(true);
    expect((await submit(grant)).status).toBe(200);
    const poll = await (await env.call(OWNER_MAILBOX_POLL, 'GET')).json() as {
      entries: Array<{ kind: string; authority: { ownerId: string }; body: unknown }>;
    };
    expect(poll.entries).toMatchObject([{ kind: 'listening_grant', authority: { ownerId: binding.ownerId }, body: grant }]);
  });
  it('pins listening writes to the signed-in owner, exact binding and generation', async () => {
    const env = await setup();
    const second = { ...binding, bindingId: 'binding-second', agentParticipantId: 'agent-second',
      deviceId: 'device-second', sessionId: 'session-second' } as SessionBinding;
    const foreign = { ...binding, bindingId: 'binding-foreign', ownerId: 'owner-foreign',
      agentParticipantId: 'agent-foreign', deviceId: 'device-foreign', sessionId: 'session-foreign' } as SessionBinding;
    for (const item of [second, foreign]) expect((await env.bindings.putParticipant({
      ownerId: item.ownerId, roomId: '!room:example' as RoomId, agentParticipantId: item.agentParticipantId,
      expectedBindingId: null, record: { binding: item, revokedGeneration: null, capability: null },
    })).kind).toBe('applied');
    const mode = { v: 1, commandId: 'mode_command_12345678', bindingId: binding.bindingId,
      expectedBindingGeneration: binding.generation, expectedVersion: 1,
      requested: 'steer', issuedAt: '2026-09-27T00:00:00Z' };
    const submit = (body: unknown, operationId = mode.commandId, bindingId = binding.bindingId) =>
      env.call(OWNER_MAILBOX_SUBMIT, 'POST', { bindingId, operationId, kind: 'listening_set', body });
    expect((await submit({ ...mode, expectedBindingGeneration: 1 })).status).toBe(409);
    expect((await submit({ ...mode, bindingId: second.bindingId })).status).toBe(409);
    expect((await submit({ ...mode, bindingId: foreign.bindingId }, mode.commandId, foreign.bindingId)).status).toBe(403);
    expect((await submit(mode)).status).toBe(200);
    expect((await submit(mode)).status).toBe(200);
    expect((await submit({ ...mode, requested: 'sync' })).status).toBe(409);
    const poll = await (await env.call(OWNER_MAILBOX_POLL, 'GET')).json() as { entries: Array<{ kind: string; authority: { ownerId: string } }> };
    expect(poll.entries).toMatchObject([{ kind: 'listening_set', authority: { ownerId: binding.ownerId } }]);
    const result = { v: 1, commandId: mode.commandId, bindingId: binding.bindingId,
      generation: binding.generation, outcome: 'applied', version: 2,
      requested: 'steer', effective: 'steer', reason: null };
    expect((await env.call(OWNER_MAILBOX_COMPLETE, 'POST', { bindingId: binding.bindingId,
      operationId: mode.commandId, outcome: { ...result, bindingId: second.bindingId } })).status).toBe(409);
    expect((await env.call(OWNER_MAILBOX_COMPLETE, 'POST', { bindingId: binding.bindingId,
      operationId: mode.commandId, outcome: result })).status).toBe(200);
    expect((await submit(mode)).status).toBe(200);
    env.setSignedIn(false);
    expect((await submit(mode, 'mode_command_87654321')).status).toBe(401);
  });
  it.each([
    [{ authUnavailable: true }, 'auth', 'session_store_unavailable'],
    [{ bindingReadUnavailable: true }, 'binding_read', 'store_unavailable'],
    [{ membershipUnavailable: true }, 'membership', 'matrix_unavailable'],
    [{ mailboxReadUnavailable: true }, 'mailbox_submit', 'archive_read_unavailable'],
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
    expect(await response.json()).toEqual({ code: 'unavailable', stage: 'mailbox_submit', errorCode: 'archive_read_unavailable' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('distinguishes a full durable-write queue from a backing-store failure', async () => {
    const env = await setup();
    const mailbox = createOwnerMailbox({ store: env.state.store, binding, roomId: '!room:example',
      clock: () => T0, authoritySecret: 'mailbox-test-secret-at-least-thirty-two-bytes' });
    for (let i = 0; i < 64; i++) {
      const operationId = `queued_write_${i.toString().padStart(8, '0')}`;
      expect((await mailbox.submit({ operationId, kind: 'review_approve', body: {
        v: 1, commandId: operationId, bindingId: binding.bindingId, roomId: '!room:example',
        expectedPolicyVersion: 3, expectedBindingGeneration: 2, issuedAt: new Date(T0).toISOString(),
        selection: [{ v: 1, roomId: '!room:example', eventId: 'event_1', authorParticipantId: 'peer_agent',
          authorDeviceId: 'peer_device', contentDigest: `sha256:${'a'.repeat(64)}` }],
      } }, principal)).kind).toBe('ok');
    }
    const response = await env.call(OWNER_MAILBOX_SUBMIT, 'POST', command);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: 'unavailable', stage: 'mailbox_submit', errorCode: 'mailbox_full' });
    expect(env.diagnostics).toEqual([{ stage: 'mailbox_submit', code: 'mailbox_full' }]);
    const stopId = 'stop_after_full_writes';
    expect((await mailbox.submit({ operationId: stopId, kind: 'channel_stop', body: {
      operationId: stopId, ownerId: binding.ownerId, roomId: '!room:example', expectedRoomRevision: 0,
    } }, principal)).kind).toBe('ok');
    const pending = await mailbox.pending();
    expect(pending.kind).toBe('ok');
    if (pending.kind !== 'ok') throw new Error('pending mailbox unavailable');
    expect(pending.value).toHaveLength(65);
    expect(pending.value.at(-1)?.operationId).toBe(stopId);
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
  it('serves owner-scoped offline review status and revokes it with the binding', async () => {
    const env = await setup();
    const status = `${OWNER_REVIEW_STATUS}?binding_id=${binding.bindingId}`;
    expect(await (await env.call(status, 'GET')).json()).toEqual({ v: 1, bindingId: binding.bindingId,
      generation: binding.generation, status: 'waiting_for_agent', preview: null });
    expect(await env.bindings.updateBinding(binding.bindingId, record => ({ ...record, revokedGeneration: 3 }))).toBe('applied');
    expect((await env.call(status, 'GET')).status).toBe(403);
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
