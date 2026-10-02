import { expect, it } from 'vitest';
import { registerAgentHandlers } from './handlers';

it('keeps an empty frozen agent domain for hosted discovery', () => {
  const routes = registerAgentHandlers();
  expect(routes).toEqual([]);
  expect(Object.isFrozen(routes)).toBe(true);
});
