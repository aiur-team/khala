import { describe, expect, it } from 'vitest';
import { registerAgentHandlers } from './handlers';

describe('registerAgentHandlers', () => {
  it('reserves status, pairing and channel-access routes without import-time dependencies', async () => {
    const registrations = registerAgentHandlers();

    expect(registrations.map(({ path, methods }) => ({ path, methods }))).toEqual([
      { path: '/api/agent/status', methods: ['GET'] },
      { path: '/api/agent/pairing/claim', methods: ['POST'] },
      { path: '/api/agent/pairing/result', methods: ['POST'] },
      { path: '/api/agent/channel-access/request', methods: ['POST'] },
      { path: '/api/agent/channel-access/create', methods: ['POST'] },
      { path: '/api/agent/channel-access/status', methods: ['GET'] },
      { path: '/api/agent/channel-access/exchange', methods: ['POST'] },
      { path: '/api/agent/channel-access/ready', methods: ['POST'] },
      { path: '/api/agent/channel-access/resume', methods: ['POST'] },
      { path: '/api/agent/channel-discovery/bootstrap/token', methods: ['POST'] },
      { path: '/api/agent/channels', methods: ['GET'] },
    ]);
    for (const [index, registration] of registrations.entries()) {
      const response = await registration.handle(new Request(`https://example.test${registration.path}`));
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await response.json()).toEqual(index === 0
        ? { code: 'feature_unavailable' }
        : index < 9
          ? { v: 1, kind: 'rejected', code: 'feature_unavailable' }
          : { error: 'feature_unavailable' });
    }
  });

  it('substitutes live pairing registrations while preserving live status behavior', () => {
    const claim = { path: '/api/agent/pairing/claim', methods: ['POST'], handle: async () => new Response('claim') } as const;
    const result = { path: '/api/agent/pairing/result', methods: ['POST'], handle: async () => new Response('result') } as const;
    const registrations = registerAgentHandlers({
      authorize: async () => 'allowed',
      status: { snapshot: async () => ({ generation: 0, agents: [] }) },
      pairing: () => [claim, result],
    });
    expect(registrations.slice(1, 3)).toEqual([claim, result]);
  });

  it('places live channel-access registrations after status and pairing', () => {
    const access = { path: '/api/agent/channel-access/request', methods: ['POST'], handle: async () => new Response('access') } as const;
    const create = { path: '/api/agent/channel-access/create', methods: ['POST'], handle: async () => new Response('create') } as const;
    const status = { path: '/api/agent/channel-access/status', methods: ['GET'], handle: async () => new Response('status') } as const;
    const registrations = registerAgentHandlers({
      authorize: async () => 'allowed',
      status: { snapshot: async () => ({ generation: 0, agents: [] }) },
      channelAccess: () => [access, create, status],
    });
    const start = registrations.indexOf(access);
    expect(registrations.slice(start, start + 3)).toEqual([access, create, status]);
    expect(registrations.slice(0, start).map(({ path }) => path)).toEqual([
      '/api/agent/status',
      ...registerAgentHandlers().map(({ path }) => path).filter(path => path.startsWith('/api/agent/pairing/')),
    ]);
  });

  it('substitutes only the live channel-discovery bootstrap registration', () => {
    const token = {
      path: '/api/agent/channel-discovery/bootstrap/token',
      methods: ['POST'],
      handle: async () => new Response('token'),
    } as const;
    const registrations = registerAgentHandlers({
      authorize: async () => 'allowed',
      status: { snapshot: async () => ({ generation: 0, agents: [] }) },
      channelDiscoveryBootstrap: () => [token],
    });

    expect(registrations.at(-2)).toBe(token);
    expect(registrations.slice(1, 3).map(route => route.path)).toEqual([
      '/api/agent/pairing/claim',
      '/api/agent/pairing/result',
    ]);
  });

  it('substitutes only the live channel-listing registration', () => {
    const channels = { path: '/api/agent/channels', methods: ['GET'], handle: async () => new Response('channels') } as const;
    const registrations = registerAgentHandlers({
      authorize: async () => 'allowed',
      status: { snapshot: async () => ({ generation: 0, agents: [] }) },
      channelDiscovery: () => [channels],
    });

    expect(registrations.at(-1)).toBe(channels);
    expect(registrations.at(-2)?.path).toBe('/api/agent/channel-discovery/bootstrap/token');
  });

  it('authorizes and returns the content-free room presence snapshot', async () => {
    const sourceSnapshot = {
      generation: 4,
      internalGenerationNote: 'must not escape',
      agents: [{
        participantId: 'agent-1',
        displayName: 'Build agent',
        ownerDisplayName: 'Owner',
        connection: 'connected' as const,
        routeLabel: 'Codex CLI',
        lastReceipt: {
          kind: 'context_consumed' as const,
          observedAt: '2026-09-19T12:00:00.000Z',
          internalEvidence: 'must not escape',
        },
        installCommand: "khala connect 'https://khala.example/room/link'",
        pendingPlaintext: 'must not escape',
      }],
    };
    const registrations = registerAgentHandlers({
      authorize: async () => 'allowed',
      status: {
        snapshot: async () => sourceSnapshot,
      },
    });

    const response = await registrations[0]!.handle(
      new Request('https://example.test/api/agent/status?roomId=room-1'),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      generation: 4,
      agents: [{
        participantId: 'agent-1',
        displayName: 'Build agent',
        ownerDisplayName: 'Owner',
        connection: 'connected',
        routeLabel: 'Codex CLI',
        lastReceipt: { kind: 'context_consumed', observedAt: '2026-09-19T12:00:00.000Z' },
        installCommand: "khala connect 'https://khala.example/room/link'",
      }],
    });
  });

  it.each([
    ['unauthenticated', 401],
    ['forbidden', 403],
  ] as const)('maps %s authorization without querying status', async (authorization, expectedStatus) => {
    let reads = 0;
    const registration = registerAgentHandlers({
      authorize: async () => authorization,
      status: { snapshot: async () => { reads += 1; throw new Error('must not read'); } },
    })[0]!;

    const response = await registration.handle(
      new Request('https://example.test/api/agent/status?roomId=room-1'),
    );

    expect(response.status).toBe(expectedStatus);
    expect(reads).toBe(0);
  });

  it('rejects a missing room identifier before authorization', async () => {
    let authorizations = 0;
    const registration = registerAgentHandlers({
      authorize: async () => { authorizations += 1; return 'allowed'; },
      status: { snapshot: async () => ({ generation: 0, agents: [] }) },
    })[0]!;

    const response = await registration.handle(new Request('https://example.test/api/agent/status'));

    expect(response.status).toBe(400);
    expect(authorizations).toBe(0);
  });
});
