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
});
