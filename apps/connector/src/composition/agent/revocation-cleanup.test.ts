import { describe, expect, it, vi } from 'vitest';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import type { ProofSigner } from '@khala/connector/bootstrap/proof';
import { createProductionRevocationCleanup } from './revocation-cleanup';

const origin = 'https://khala.aiur.team';
const binding = { v: 1, bindingId: 'binding-revocation', ownerId: 'owner-revocation',
  agentParticipantId: 'agent-revocation', deviceId: 'device-revocation', harness: 'codex',
  sessionId: 'session-revocation', generation: 3 } as SessionBinding;
const command = { v: 1, operationId: 'operation_revocation', deviceId: binding.deviceId,
  deviceKey: 'B'.repeat(43), generation: binding.generation, removal: null };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status,
  headers: { 'content-type': 'application/json' } });

function setup(answer: unknown = command) {
  const removed = vi.fn(async () => 'removed' as const);
  const quiesce = vi.fn(async () => undefined);
  const requests: Array<{ path: string; body: unknown }> = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) as unknown : null });
    if (path.endsWith('/cleanup')) return reply(200, answer);
    return reply(200, { v: 1, operationId: command.operationId, removal: 'removed' });
  }) as unknown as typeof globalThis.fetch;
  const cleanup = createProductionRevocationCleanup({ appOrigin: origin, binding,
    signer: { proof: () => 'signed-proof' } as unknown as ProofSigner,
    existingCapability: async () => ({ token: 'C'.repeat(43), bindingId: binding.bindingId,
      generation: binding.generation, scope: [], expiresAt: Date.now() + 60_000 }),
    quiesce, removeOwnDevice: removed, fetch });
  return { cleanup, removed, quiesce, requests };
}

describe('revoked connector SDK cleanup', () => {
  it('quiesces before deleting the exact published key and submits one typed receipt', async () => {
    const h = setup();
    expect(await h.cleanup.pollOnce()).toBe('complete');
    expect(h.quiesce).toHaveBeenCalledOnce();
    expect(h.removed).toHaveBeenCalledExactlyOnceWith(command.deviceKey);
    expect(h.requests).toEqual([
      { path: '/api/agent/revocation/cleanup', body: null },
      { path: '/api/agent/revocation/result', body: { operationId: command.operationId,
        deviceId: binding.deviceId, deviceKey: command.deviceKey, generation: 3, removal: 'removed' } },
    ]);
    expect(await h.cleanup.pollOnce()).toBe('complete');
    expect(h.removed).toHaveBeenCalledOnce();
  });

  it('never calls the SDK for another device or an invented removal result', async () => {
    const h = setup({ ...command, deviceId: 'other-device' });
    expect(await h.cleanup.pollOnce()).toBe('unavailable');
    expect(h.quiesce).not.toHaveBeenCalled();
    expect(h.removed).not.toHaveBeenCalled();
  });
});
