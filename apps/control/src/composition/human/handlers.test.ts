import { describe, expect, it } from 'vitest';
import { registerHumanHandlers } from './handlers';

describe('registerHumanHandlers', () => {
  it('reserves the exact human pairing and channel-access surface with finite immutable fallbacks', async () => {
    const registrations = registerHumanHandlers();
    expect(registrations.map(({ path, methods }) => ({ path, methods }))).toEqual([
      { path: '/api/human/pairing/request', methods: ['POST', 'GET'] },
      { path: '/api/human/pairing/decision', methods: ['POST'] },
      { path: '/api/human/channel-access/inbox', methods: ['GET'] },
      { path: '/api/human/channel-access/decision', methods: ['POST'] },
      { path: '/api/human/channel-access/mute', methods: ['POST'] },
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
    expect(registerHumanHandlers({ pairing: () => [request, decision] }).slice(0, 2)).toEqual([request, decision]);
  });

  it('appends live channel-access registrations after pairing', () => {
    const inbox = { path: '/api/human/channel-access/inbox', methods: ['GET'], handle: async () => new Response('inbox') } as const;
    const decision = { path: '/api/human/channel-access/decision', methods: ['POST'], handle: async () => new Response('decision') } as const;
    const mute = { path: '/api/human/channel-access/mute', methods: ['POST'], handle: async () => new Response('mute') } as const;
    expect(registerHumanHandlers({ channelAccess: () => [inbox, decision, mute] }).slice(-3)).toEqual([inbox, decision, mute]);
  });
});
