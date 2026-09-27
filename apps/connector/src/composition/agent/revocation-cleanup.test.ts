import { describe, expect, it, vi } from 'vitest';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import type { ProofSigner } from '@khala/connector/bootstrap/proof';
import { revocationStopId } from '../../../../control/src/composition/human/revocation-cleanup';
import { createProductionRevocationCleanup } from './revocation-cleanup';

const origin = 'https://khala.aiur.team';
const binding = { v: 1, bindingId: 'binding-revocation', ownerId: 'owner-revocation',
  agentParticipantId: 'agent-revocation', deviceId: 'device-revocation', harness: 'codex',
  sessionId: 'session-revocation', generation: 3 } as SessionBinding;
const command = { v: 1, operationId: 'operation_revocation', deviceId: binding.deviceId,
  deviceKey: 'B'.repeat(43), generation: binding.generation, removal: null };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status,
  headers: { 'content-type': 'application/json' } });

function setup(answer: unknown = command, stopAvailable = true, stopPostAvailable = true,
  removalPostAvailable = true) {
  const order: string[] = [];
  let deviceAvailable = true;
  const removed = vi.fn(async () => { order.push('remove'); return deviceAvailable ? 'removed' as const : 'unavailable' as const; });
  const stop = vi.fn(async (operationId: string) => {
    order.push('stop');
    if (!stopAvailable) return { kind: 'unavailable' as const };
    return { kind: 'stopped' as const, receipt: {
    operationId, ownerId: binding.ownerId, roomId: '!room:example', expectedRoomRevision: 0,
    bindingId: binding.bindingId, bindingGeneration: binding.generation,
    state: 'stopped' as const, cleanupRequested: true as const,
  } }; });
  const requests: Array<{ path: string; body: unknown }> = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const payload = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    requests.push({ path, body: payload });
    if (path.endsWith('/cleanup')) return reply(200, answer);
    order.push(payload?.removal === null ? 'post_stop' : 'post_removal');
    if (payload?.removal === null && !stopPostAvailable) return reply(503, { code: 'unavailable' });
    if (payload?.removal !== null && !removalPostAvailable) return reply(503, { code: 'unavailable' });
    return reply(200, { v: 1, operationId: command.operationId, removal: payload?.removal });
  }) as unknown as typeof globalThis.fetch;
  const cleanup = createProductionRevocationCleanup({ appOrigin: origin, binding,
    signer: { proof: () => 'signed-proof' } as unknown as ProofSigner,
    existingCapability: async () => ({ token: 'C'.repeat(43), bindingId: binding.bindingId,
      generation: binding.generation, scope: [], expiresAt: Date.now() + 60_000 }),
    stop, removeOwnDevice: removed, fetch });
  return { cleanup, removed, stop, requests, order, setDeviceAvailable(value: boolean) { deviceAvailable = value; } };
}

describe('revoked connector SDK cleanup', () => {
  it('persists local Stop before deleting the exact published key and submits its typed receipt', async () => {
    const h = setup();
    expect(await h.cleanup.pollOnce()).toBe('complete');
    expect(h.stop).toHaveBeenCalledOnce();
    expect(h.stop).toHaveBeenCalledExactlyOnceWith(revocationStopId(command.operationId, binding.bindingId));
    expect(h.removed).toHaveBeenCalledExactlyOnceWith(command.deviceKey);
    expect(h.order).toEqual(['stop', 'post_stop', 'remove', 'post_removal']);
    expect(h.requests).toEqual([
      { path: '/api/agent/revocation/cleanup', body: null },
      { path: '/api/agent/revocation/result', body: { operationId: command.operationId,
        deviceId: binding.deviceId, deviceKey: command.deviceKey, generation: 3, removal: null,
        localStop: { operationId: revocationStopId(command.operationId, binding.bindingId),
          ownerId: binding.ownerId, roomId: '!room:example', expectedRoomRevision: 0,
          bindingId: binding.bindingId, bindingGeneration: binding.generation,
          state: 'stopped', cleanupRequested: true } } },
      { path: '/api/agent/revocation/result', body: { operationId: command.operationId,
        deviceId: binding.deviceId, deviceKey: command.deviceKey, generation: 3, removal: 'removed' } },
    ]);
    expect(await h.cleanup.pollOnce()).toBe('complete');
    expect(h.removed).toHaveBeenCalledOnce();
  });

  it('never calls the SDK for another device or an invented removal result', async () => {
    const h = setup({ ...command, deviceId: 'other-device' });
    expect(await h.cleanup.pollOnce()).toBe('unavailable');
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.removed).not.toHaveBeenCalled();
  });

  it('keeps cleanup pending when the local Stop cannot be synced', async () => {
    const h = setup(command, false);
    expect(await h.cleanup.pollOnce()).toBe('pending');
    expect(h.stop).toHaveBeenCalledOnce();
    expect(h.removed).not.toHaveBeenCalled();
    expect(h.requests).toEqual([{ path: '/api/agent/revocation/cleanup', body: null }]);
  });

  it('does not remove the Matrix device before the durable Stop result is acknowledged', async () => {
    const h = setup(command, true, false);
    expect(await h.cleanup.pollOnce()).toBe('pending');
    expect(h.stop).toHaveBeenCalledOnce();
    expect(h.removed).not.toHaveBeenCalled();
    expect(h.requests.map(request => request.path)).toEqual([
      '/api/agent/revocation/cleanup', '/api/agent/revocation/result',
    ]);
  });

  it('retains the Stop proof but never invents removal after device deletion and a lost result', async () => {
    const h = setup(command, true, true, false);
    expect(await h.cleanup.pollOnce()).toBe('pending');
    expect(h.order).toEqual(['stop', 'post_stop', 'remove', 'post_removal']);
    h.setDeviceAvailable(false);
    expect(await h.cleanup.pollOnce()).toBe('pending');
    expect(h.order).toEqual(['stop', 'post_stop', 'remove', 'post_removal', 'stop', 'post_stop', 'remove']);
    expect(h.requests.filter(request => (request.body as { removal?: unknown } | null)?.removal === 'removed')).toHaveLength(1);
  });
});
