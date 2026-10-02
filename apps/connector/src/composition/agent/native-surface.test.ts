import { expect, test } from 'vitest';
import { registerAgentHandlers } from '../../../../control/src/composition/agent/handlers';

test('unauthorized channel status never reads connector metadata', async () => {
  let reads = 0;
  const handler = registerAgentHandlers({
    authorize: async () => 'forbidden',
    status: { snapshot: async () => { reads += 1; throw new Error('must not read'); } },
  })[0]!;

  const response = await handler.handle(
    new Request('https://khala.example/api/agent/status?roomId=room-integration-1'),
  );

  expect(response.status).toBe(403);
  expect(reads).toBe(0);
});
