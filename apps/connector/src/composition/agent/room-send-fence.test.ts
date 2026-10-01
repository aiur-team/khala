import { describe, expect, it, vi } from 'vitest';
import type { ProofSigner } from '@khala/connector/bootstrap/proof';
import { createAgentRoomSendFence } from './room-send-fence';

const origin = 'https://khala.aiur.team';
const response = (status: number, value: unknown) => new Response(JSON.stringify(value), { status,
  headers: { 'content-type': 'application/json' } });

describe('connector room send barrier client', () => {
  it('discards an existing SDK session before registering, then records the exact send outcome', async () => {
    const effects: string[] = [];
    const bodies: unknown[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const action = new URL(String(url)).pathname.split('/').at(-1)!;
      effects.push(action);
      bodies.push(init?.body ? JSON.parse(String(init.body)) as unknown : null);
      expect(init?.headers).toMatchObject({ authorization: `DPoP ${'C'.repeat(43)}`, dpop: 'proof' });
      if (action === 'ready' || action === 'finish') return response(200, { kind: 'applied' });
      if (action === 'acquire') return response(200, { kind: 'granted', permitId: 'permit_a', attempt: 0 });
      return response(503, { kind: 'unavailable' });
    }) as unknown as typeof globalThis.fetch;
    const fence = createAgentRoomSendFence({ appOrigin: origin, bindingId: 'binding_a', generation: 3,
      signer: { proof: () => 'proof' } as unknown as ProofSigner,
      capability: async () => ({ token: 'C'.repeat(43), bindingId: 'binding_a', generation: 3,
        scope: ['publish_own'], expiresAt: Date.now() + 60_000 }),
      discardOutboundSession: async () => { effects.push('sdk_discard'); return true; }, fetch });
    expect(await fence.acquire('txn_a')).toEqual({ kind: 'granted', permitId: 'permit_a', attempt: 0 });
    expect(await fence.finish('permit_a', 0, { kind: 'complete', eventId: '$sent:example' })).toBe(true);
    expect(effects).toEqual(['sdk_discard', 'ready', 'acquire', 'finish']);
    expect(bodies[2]).toEqual({ permitId: 'permit_a', attempt: 0,
      outcome: 'complete', eventId: '$sent:example' });
  });

  it('keeps a held room unsent and only reports rotation after the SDK discard succeeds', async () => {
    let discards = 0;
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const action = new URL(String(url)).pathname.split('/').at(-1)!;
      calls.push(action);
      if (action === 'ready') return response(423, { kind: 'held' });
      if (action === 'acquire') return response(423, { kind: 'held', operationId: 'operation_a', epoch: 1 });
      return response(200, { kind: 'applied' });
    }) as unknown as typeof globalThis.fetch;
    const fence = createAgentRoomSendFence({ appOrigin: origin, bindingId: 'binding_a', generation: 3,
      signer: { proof: () => 'proof' } as unknown as ProofSigner,
      capability: async () => ({ token: 'C'.repeat(43), bindingId: 'binding_a', generation: 3,
        scope: ['publish_own'], expiresAt: Date.now() + 60_000 }),
      discardOutboundSession: async () => { discards += 1; return discards > 1; }, fetch });
    expect(await fence.acquire('txn_b')).toEqual({ kind: 'held', operationId: 'operation_a', epoch: 1 });
    expect(await fence.rotate('operation_a', 1)).toBe(true);
    expect(calls).toEqual(['acquire', 'rotation']);
    expect(discards).toBe(2);
  });
});
