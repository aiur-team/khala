import { describe, expect, it } from 'vitest';
import { registerHumanHandlers } from './handlers';

describe('registerHumanHandlers', () => {
  it('reserves the exact human pairing surface with finite immutable fallbacks', async () => {
    const registrations = registerHumanHandlers();
    expect(registrations.map(({ path, methods }) => ({ path, methods }))).toEqual([
      { path: '/api/human/pairing/request', methods: ['POST', 'GET'] },
      { path: '/api/human/pairing/decision', methods: ['POST'] },
    ]);
    expect(Object.isFrozen(registrations)).toBe(true);
    for (const registration of registrations) {
      expect(Object.isFrozen(registration)).toBe(true);
      const response = await registration.handle(new Request(`https://example.test${registration.path}`));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ v: 1, kind: 'rejected', code: 'feature_unavailable' });
    }
  });

  it('substitutes live pairing registrations', () => {
    const request = { path: '/api/human/pairing/request', methods: ['POST', 'GET'], handle: async () => new Response('request') } as const;
    const decision = { path: '/api/human/pairing/decision', methods: ['POST'], handle: async () => new Response('decision') } as const;
    expect(registerHumanHandlers({ pairing: () => [request, decision] })).toEqual([request, decision]);
  });
});
