import { describe, expect, it } from 'vitest';
import { registerHumanHandlers } from './handlers';

describe('registerHumanHandlers', () => {
  it('reserves the exact human pairing surface with finite immutable fallbacks', async () => {
    const registrations = registerHumanHandlers();
    expect(registrations.map(({ path, methods }) => ({ path, methods }))).toEqual([
      { path: '/api/human/pairing/request', methods: ['POST', 'GET'] },
      { path: '/api/human/pairing/decision', methods: ['POST'] },
      { path: '/api/human/channel-discovery/bootstrap/authorize', methods: ['GET', 'POST'] },
      { path: '/api/human/channel-discovery/settings', methods: ['PUT'] },
      { path: '/api/human/channel-discovery/allowlist', methods: ['POST'] },
      { path: '/api/human/channel-discovery/rollout', methods: ['PUT'] },
    ]);
    expect(Object.isFrozen(registrations)).toBe(true);
    for (const registration of registrations) {
      expect(Object.isFrozen(registration)).toBe(true);
      const response = await registration.handle(new Request(`https://example.test${registration.path}`));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual(registration.path.includes('channel-discovery/bootstrap')
        ? { error: 'feature_unavailable' }
        : { v: 1, kind: 'rejected', code: 'feature_unavailable' });
    }
  });

  it('substitutes live pairing registrations', () => {
    const request = { path: '/api/human/pairing/request', methods: ['POST', 'GET'], handle: async () => new Response('request') } as const;
    const decision = { path: '/api/human/pairing/decision', methods: ['POST'], handle: async () => new Response('decision') } as const;
    expect(registerHumanHandlers({ pairing: () => [request, decision] }).slice(0, 2)).toEqual([request, decision]);
  });

  it('substitutes only the live channel-discovery bootstrap registration', () => {
    const authorize = {
      path: '/api/human/channel-discovery/bootstrap/authorize',
      methods: ['GET', 'POST'],
      handle: async () => new Response('authorize'),
    } as const;
    const registrations = registerHumanHandlers({ channelDiscoveryBootstrap: () => [authorize] });

    expect(registrations.at(-4)).toBe(authorize);
    expect(registrations.slice(0, 2).map(route => route.path)).toEqual([
      '/api/human/pairing/request',
      '/api/human/pairing/decision',
    ]);
  });

  it('substitutes only the live channel-discovery settings registrations', () => {
    const settings = { path: '/api/human/channel-discovery/settings', methods: ['PUT'], handle: async () => new Response('settings') } as const;
    const allowlist = { path: '/api/human/channel-discovery/allowlist', methods: ['POST'], handle: async () => new Response('allowlist') } as const;
    const rollout = { path: '/api/human/channel-discovery/rollout', methods: ['PUT'], handle: async () => new Response('rollout') } as const;
    const registrations = registerHumanHandlers({ channelDiscovery: () => [settings, allowlist, rollout] });

    expect(registrations.slice(-3)).toEqual([settings, allowlist, rollout]);
    expect(registrations.at(-4)?.path).toBe('/api/human/channel-discovery/bootstrap/authorize');
  });
});
