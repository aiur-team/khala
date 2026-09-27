import { describe, expect, it } from 'vitest';
import { createOwnerDeviceClient } from './owner-device-client';

const origin = 'https://khala.example';
const roomId = '!room:example' as never;
const bindingId = 'binding_12345678' as never;
const proof = { deviceId: 'BROWSER', fingerprint: 'A'.repeat(43), matrixAccessToken: 'transient-token' };
const json = (status: number, value: unknown) => new Response(JSON.stringify(value),
  { status, headers: { 'content-type': 'application/json' } });

describe('protected owner device proof client', () => {
  it('challenges and registers the active SDK key with a transient Matrix token', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createOwnerDeviceClient({ origin, csrf: async () => 'csrf-value', fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return calls.length === 1 ? json(200, { v: 1, nonce: 'N'.repeat(43), expiresAt: '2026-09-27T00:00:00Z' })
        : json(200, { v: 1, kind: 'pinned' });
    } });
    expect(await client.register(roomId, bindingId, 2, proof)).toBe(true);
    expect(calls[0]?.url).toContain('binding_generation=2');
    expect(calls[1]?.url).toBe(`${origin}/api/human/owner-device-proof/register`);
    expect(calls[1]?.init.credentials).toBe('same-origin');
    expect(calls[1]?.init.headers).toMatchObject({ 'x-khala-csrf': 'csrf-value' });
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ v: 1, roomId, bindingId, generation: 2,
      ...proof, nonce: 'N'.repeat(43) });
  });

  it('fails closed on malformed challenges and registration refusal', async () => {
    let writes = 0;
    const invalid = createOwnerDeviceClient({ origin, csrf: async () => 'csrf-value', fetch: async () => {
      writes += 1;
      return json(200, { v: 1, nonce: 'short' });
    } });
    expect(await invalid.register(roomId, bindingId, 2, proof)).toBe(false);
    expect(writes).toBe(1);
    const refused = createOwnerDeviceClient({ origin, csrf: async () => 'csrf-value', fetch: async url =>
      String(url).includes('challenge') ? json(200, { v: 1, nonce: 'N'.repeat(43) }) : json(503, { code: 'unavailable' }) });
    expect(await refused.register(roomId, bindingId, 2, proof)).toBe(false);
  });
});
