import { describe, expect, it } from 'vitest';
import { registerAgentHandlers } from './handlers';

describe('registerAgentHandlers', () => {
  it('reserves one content-free status route without import-time dependencies', async () => {
    const registrations = registerAgentHandlers();

    expect(registrations.map(({ path, methods }) => ({ path, methods }))).toEqual([
      { path: '/api/agent/status', methods: ['GET'] },
    ]);
    const response = await registrations[0]!.handle(
      new Request('https://example.test/api/agent/status'),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: 'feature_unavailable' });
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
