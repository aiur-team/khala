import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import type { ProofSigner } from '@khala/connector/bootstrap/proof';
import type { AuthService } from '../../../../control/src/auth/index';
import type { AdmissionGateway } from '../../../../control/src/invitations/index';
import type { AdapterCapabilities } from '../../../../control/src/agent-bootstrap/handler';
import { fakeStore, T0 } from '../../../../control/src/auth/support.test';
import { createAgentBindingStore } from '../../../../control/src/agent-bootstrap/store';
import { createOwnerMailbox } from '../../../../control/src/composition/owner-mailbox/store';
import { createOwnerMailboxRoutes } from '../../../../control/src/composition/owner-mailbox/routes';
import { createProductionOwnerMailbox } from './owner-mailbox';

const binding = { v: 1, bindingId: 'binding-hosted-1', ownerId: 'owner-hosted-1',
  agentParticipantId: 'agent-hosted-1', deviceId: 'device-hosted-1', harness: 'codex',
  sessionId: 'thread-hosted-1', generation: 0 } as SessionBinding;
const authority = { ownerId: binding.ownerId, issuer: 'https://issuer.test', subject: 'subject-1',
  authenticatedAt: '2026-09-26T00:00:00.000Z', authorizationId: 'authz_' + 'A'.repeat(43) };
const entry = { operationId: 'operation-hosted-1', kind: 'controls_status',
  body: { bindingId: binding.bindingId }, authority, outcome: null };
const response = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

function fixture(fetcher: typeof fetch) {
  const status = vi.fn(async () => ({ ok: false as const, code: 'unavailable' as const }));
  const stopped = vi.fn(async () => ({ kind: 'unavailable' as const }));
  const revoked = vi.fn(async () => undefined);
  const signer = { jkt: 'A'.repeat(43), publicKey: 'B'.repeat(43), proof: vi.fn(() => 'signed-proof') } as unknown as ProofSigner;
  const mailbox = createProductionOwnerMailbox({ appOrigin: 'https://khala.aiur.team', binding,
    signer, capability: async () => ({ token: 'C'.repeat(43), scope: ['publish_own', 'receive_released', 'ack_delivery'],
      bindingId: binding.bindingId, generation: binding.generation, expiresAt: Date.now() + 60_000 }),
    controls: { status, setPolicy: vi.fn(), reconcile: vi.fn() },
    review: { preview: vi.fn(), approve: vi.fn(), resumeReleases: vi.fn(), dispose: vi.fn() },
    stop: stopped, onRevoked: revoked, fetch: fetcher,
  });
  return { mailbox, status, stopped, revoked, signer };
}

describe('protected hosted owner mailbox endpoint', () => {
  it('keeps policy status readable and returns a typed refusal while listening is offline', async () => {
    const mode = { v: 1, commandId: 'mode_command_12345678', bindingId: binding.bindingId,
      expectedBindingGeneration: binding.generation, expectedVersion: 1,
      requested: 'sync', issuedAt: '2026-09-26T00:00:00Z' };
    const grant = { v: 1, kind: 'grant_experimental_route', commandId: 'grant_command_12345678',
      bindingId: binding.bindingId, expectedBindingGeneration: binding.generation,
      expectedVersion: 1, mode: 'steer', route: 'codex-steer', harnessVersion: '0.154.0',
      evidenceRevision: 'proof-1', issuedAt: '2026-09-26T00:00:00Z' };
    const entries = [entry, { ...entry, operationId: mode.commandId,
      kind: 'listening_set', body: mode }, { ...entry, operationId: grant.commandId,
      kind: 'listening_grant', body: grant }];
    const outcomes: Array<{ operationId: string; outcome: Record<string, unknown> }> = [];
    const signer = { proof: () => 'signed-proof' } as unknown as ProofSigner;
    const mailbox = createProductionOwnerMailbox({ appOrigin: 'https://khala.aiur.team', binding, signer,
      capability: async () => ({ token: 'C'.repeat(43), scope: ['receive_released', 'ack_delivery'],
        bindingId: binding.bindingId, generation: binding.generation, expiresAt: Date.now() + 60_000 }),
      controls: { status: async () => ({ ok: true, status: { policy: { effectiveVersion: 3 } } as never }),
        setPolicy: vi.fn(), reconcile: vi.fn() },
      listening: () => null,
      stop: async () => ({ kind: 'unavailable' }), onRevoked: async () => undefined,
      fetch: async (_url, init) => {
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as { operationId: string; outcome: Record<string, unknown> };
          outcomes.push(body);
          return response(200, { v: 1, operationId: body.operationId });
        }
        return response(200, { v: 1, bindingId: binding.bindingId, generation: binding.generation,
          closing: false, entries });
      },
    });
    expect(await mailbox.pollOnce()).toBe('ok');
    expect(outcomes).toHaveLength(3);
    expect(outcomes[0]?.outcome).toMatchObject({ ok: true, status: { policy: { effectiveVersion: 3 },
      listening: null, listeningUnavailable: 'connector_starting' } });
    expect(outcomes[1]?.outcome).toMatchObject({ v: 1, commandId: mode.commandId,
      outcome: 'refused', reason: 'unavailable', effective: null });
    expect(outcomes[2]?.outcome).toEqual({ commandId: grant.commandId,
      outcome: 'refused', reason: 'unavailable' });
  });
  it('returns a typed unavailable refusal when an installed listening adapter returns null', async () => {
    const mode = { v: 1, commandId: 'mode_command_null_12345678', bindingId: binding.bindingId,
      expectedBindingGeneration: binding.generation, expectedVersion: 1,
      requested: 'sync', issuedAt: '2026-09-26T00:00:00Z' };
    let completed: Record<string, unknown> | null = null;
    const mailbox = createProductionOwnerMailbox({ appOrigin: 'https://khala.aiur.team', binding,
      signer: { proof: () => 'signed-proof' } as unknown as ProofSigner,
      capability: async () => ({ token: 'C'.repeat(43), scope: ['receive_released', 'ack_delivery'],
        bindingId: binding.bindingId, generation: binding.generation, expiresAt: Date.now() + 60_000 }),
      controls: { status: vi.fn(), setPolicy: vi.fn(), reconcile: vi.fn() },
      listening: () => ({ read: vi.fn(), set: async () => null }) as never,
      stop: async () => ({ kind: 'unavailable' }), onRevoked: async () => undefined,
      fetch: async (_url, init) => {
        if (init?.method === 'POST') {
          completed = JSON.parse(String(init.body)) as Record<string, unknown>;
          return response(200, { v: 1, operationId: mode.commandId });
        }
        return response(200, { v: 1, bindingId: binding.bindingId, generation: binding.generation,
          closing: false, entries: [{ ...entry, operationId: mode.commandId,
            kind: 'listening_set', body: mode }] });
      },
    });
    expect(await mailbox.pollOnce()).toBe('ok');
    expect(completed).toMatchObject({ operationId: mode.commandId, outcome: {
      v: 1, commandId: mode.commandId, outcome: 'refused', reason: 'unavailable', effective: null,
    } });
  });
  it('processes the server produced 64 pending previews plus reserved Stop without accepting extra commands', async () => {
    const state = fakeStore(() => T0);
    const roomId = '!room:example' as never;
    const bindings = createAgentBindingStore({ store: state.store });
    expect((await bindings.putParticipant({ ownerId: binding.ownerId, roomId,
      agentParticipantId: binding.agentParticipantId, expectedBindingId: null,
      record: { binding, revokedGeneration: null, capability: null } })).kind).toBe('applied');
    const principal = { ownerId: binding.ownerId, providerIssuer: 'https://issuer.test',
      providerSubject: 'subject-1' } as never;
    const source = createOwnerMailbox({ store: state.store, binding, roomId, clock: () => T0,
      authoritySecret: 'mailbox-test-secret-at-least-thirty-two-bytes' });
    const body = { bindingId: binding.bindingId, candidates: [], releaseIds: [] };
    const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32);
    for (let index = 0; index < 64; index++) {
      expect((await source.submit({ kind: 'review_preview', body,
        operationId: `preview_${digest}_${index.toString(16).padStart(8, '0')}` }, principal)).kind).toBe('ok');
    }
    const stop = { operationId: 'stop_operation_0001', ownerId: binding.ownerId, roomId, expectedRoomRevision: 0 };
    expect((await source.submit({ kind: 'channel_stop', operationId: stop.operationId, body: stop }, principal)).kind).toBe('ok');
    const auth = { authenticateRequest: async () => ({ kind: 'authenticated', context: { principal } }),
      requireHumanMutation: async () => ({ kind: 'authorized', context: { principal } }) } as unknown as AuthService;
    const gateway = { inspectMembership: async () => ({ kind: 'joined', historyReady: false }) } as unknown as AdmissionGateway;
    const capabilities = { authorize: async () => ({ kind: 'authorized', binding, roomId,
      ownerId: binding.ownerId }) } as unknown as AdapterCapabilities;
    const routes = createOwnerMailboxRoutes({ auth, gateway, capabilities, store: state.store,
      clock: () => T0, authoritySecret: 'mailbox-test-secret-at-least-thirty-two-bytes',
      inspectOwnerMembership: async () => ({ kind: 'joined' }),
      lookupAgentDevice: async () => null,
    });
    const poll = routes.agent.find(route => route.path.endsWith('/poll'))!;
    const produced = await poll.handle(new Request('https://khala.aiur.team' + poll.path));
    const batch = await produced.json() as { entries: unknown[] };
    expect(batch.entries).toHaveLength(65);
    const stopEntry = batch.entries[64] as { operationId: string; body: Record<string, unknown> };
    const extraStop = { ...stopEntry, operationId: 'stop_other_0001',
      body: { ...stopEntry.body, operationId: 'stop_other_0001' } };
    for (const malformed of [
      { ...batch, entries: [...batch.entries, batch.entries[0]] },
      { ...batch, entries: [...batch.entries.slice(0, 63), batch.entries[64], extraStop] },
      { ...batch, entries: [batch.entries[0], batch.entries[0]] },
      { ...batch, closing: true },
    ]) {
      const rejected = fixture(async () => response(200, malformed));
      expect(await rejected.mailbox.authorize()).toBe('unavailable');
      expect(rejected.status).not.toHaveBeenCalled();
    }
    const signer = { jkt: 'A'.repeat(43), publicKey: 'B'.repeat(43), proof: () => 'proof' } as unknown as ProofSigner;
    const reviewPreview = vi.fn(async () => ({ ok: false as const, code: 'forbidden' as const }));
    const localStop = vi.fn(async () => ({ kind: 'stopped' as const, receipt: {
      ...stop, bindingId: binding.bindingId, bindingGeneration: binding.generation,
      state: 'stopped' as const, cleanupRequested: true as const,
    } }));
    const client = createProductionOwnerMailbox({ appOrigin: 'https://khala.aiur.team', binding, signer,
      capability: async () => ({ token: 'C'.repeat(43), scope: ['receive_released', 'ack_delivery'],
        bindingId: binding.bindingId, generation: binding.generation, expiresAt: Date.now() + 60_000 }),
      review: { preview: reviewPreview, approve: vi.fn(), resumeReleases: vi.fn(), dispose: vi.fn() },
      stop: localStop, onRevoked: async () => undefined,
      fetch: async (url, init) => {
        const route = routes.agent.find(item => item.path === new URL(String(url)).pathname)!;
        return route.handle(new Request(String(url), init));
      },
    });
    expect(await client.pollOnce()).toBe('revoked');
    expect(reviewPreview).toHaveBeenCalledTimes(64);
    expect(localStop).toHaveBeenCalledOnce();
    expect((await source.pending())).toEqual({ kind: 'ok', value: [] });
  });
  it('blocks new intake at a closure marker while continuing to poll for the stop command', async () => {
    const { mailbox, status } = fixture(async () => response(200, { v: 1,
      bindingId: binding.bindingId, generation: 0, closing: true, entries: [] }));
    expect(await mailbox.authorize()).toBe('closing');
    expect(await mailbox.pollOnce()).toBe('ok');
    expect(status).not.toHaveBeenCalled();
  });

  it('rejects a cross-generation relay response before any owner handler runs', async () => {
    const { mailbox, status } = fixture(async () => response(200, { v: 1,
      bindingId: binding.bindingId, generation: 1, closing: false, entries: [entry] }));
    expect(await mailbox.pollOnce()).toBe('unavailable');
    expect(status).not.toHaveBeenCalled();
  });

  it('uses a DPoP bearer only in Authorization, with exact Origin on completion', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const { mailbox, status, signer } = fixture(async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return calls.length === 1
        ? response(200, { v: 1, bindingId: binding.bindingId, generation: 0, closing: false, entries: [entry] })
        : response(200, { v: 1, operationId: entry.operationId });
    });
    expect(await mailbox.pollOnce()).toBe('ok');
    expect(status).toHaveBeenCalledExactlyOnceWith(authority, entry.body);
    expect(calls.map(call => call.url)).toEqual([
      'https://khala.aiur.team/api/agent/owner-mailbox/poll',
      'https://khala.aiur.team/api/agent/owner-mailbox/complete',
    ]);
    expect(calls[0]!.init.headers).toMatchObject({ authorization: `DPoP ${'C'.repeat(43)}`, dpop: 'signed-proof' });
    expect(calls[1]!.init.headers).toMatchObject({ origin: 'https://khala.aiur.team' });
    expect(signer.proof).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ bindingId: binding.bindingId,
      operationId: entry.operationId, outcome: { ok: false, code: 'unavailable' } });
  });

  it('replays the same typed operation after a lost completion response', async () => {
    let polls = 0;
    const { mailbox, status } = fixture(async (url) => {
      if (String(url).endsWith('/poll')) {
        polls += 1;
        return response(200, { v: 1, bindingId: binding.bindingId, generation: 0, closing: false, entries: [entry] });
      }
      return response(polls === 1 ? 503 : 200, { v: 1, operationId: entry.operationId });
    });
    expect(await mailbox.pollOnce()).toBe('unavailable');
    expect(await mailbox.pollOnce()).toBe('ok');
    expect(status).toHaveBeenCalledTimes(2);
  });

  it('treats current-binding denial as revocation and closes the poller', async () => {
    const { mailbox, status, revoked } = fixture(async () => response(403, { code: 'binding_revoked' }));
    expect(await mailbox.pollOnce()).toBe('revoked');
    expect(revoked).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
    expect(await mailbox.pollOnce()).toBe('unavailable');
  });

  it('reports only fixed poll stages, status, and pending count', async () => {
    const diagnostic = vi.fn();
    const signer = { proof: () => 'signed-proof' } as unknown as ProofSigner;
    const mailbox = createProductionOwnerMailbox({ appOrigin: 'https://khala.aiur.team', binding,
      signer, capability: async () => ({ token: 'C'.repeat(43), scope: ['receive_released', 'ack_delivery'],
        bindingId: binding.bindingId, generation: 0, expiresAt: Date.now() + 60_000 }),
      controls: { status: async () => ({ ok: false as const, code: 'unavailable' as const }),
        setPolicy: vi.fn(), reconcile: vi.fn() },
      stop: async () => ({ kind: 'unavailable' as const }), onRevoked: async () => undefined,
      diagnostic, fetch: async url => String(url).endsWith('/poll')
        ? response(200, { v: 1, bindingId: binding.bindingId, generation: 0, closing: false, entries: [entry] })
        : response(503, { code: 'unavailable' }),
    });
    expect(await mailbox.pollOnce()).toBe('unavailable');
    expect(diagnostic.mock.calls.map(call => call[0])).toEqual([
      { stage: 'mailbox_poll_entries', result: 'ok', httpStatus: 200, pendingCount: 1 },
      { stage: 'mailbox_poll_execute', result: 'ok' },
      { stage: 'mailbox_poll_complete', result: 'unavailable', httpStatus: 503 },
    ]);
  });
});
