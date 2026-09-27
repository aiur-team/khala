import { describe, expect, it, vi } from 'vitest';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import type { ProofSigner } from '@khala/connector/bootstrap/proof';
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
});
