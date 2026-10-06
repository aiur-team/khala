import { expect, it } from 'vitest';
import { CODEX_IDLE_WAKE_NOTICE, newNonce, wakeLine } from './rules';
it('creates a content-free fixed line with an eight-hex nonce', () => {
  const nonce = newNonce();
  expect(nonce).toMatch(/^[a-f0-9]{8}$/);
  expect(wakeLine(nonce)).toBe(`${CODEX_IDLE_WAKE_NOTICE} (k-${nonce})`);
  expect(() => wakeLine('../unsafe')).toThrow('invalid_wake_nonce');
});
