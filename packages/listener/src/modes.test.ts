import { expect, it } from 'vitest';
import { DEFAULT_LISTENING_MODE, LISTENING_MODES, MODE_SUPPORT_STATUSES, decodeListeningMode } from './index';

it('keeps the strict delivery vocabulary and sync default', () => {
  expect(DEFAULT_LISTENING_MODE).toBe('sync');
  expect(LISTENING_MODES).toEqual(['steer', 'sync', 'async']);
  expect(MODE_SUPPORT_STATUSES).toEqual(['proven', 'experimental', 'blocked_without_wrapper', 'unsupported', 'unknown']);
  for (const value of ['steer', 'sync', 'async']) expect(decodeListeningMode(value)).toEqual({ ok: true, value });
  for (const value of ['mute', 'unknown', 'SYNC', undefined, null, {}, ['sync'], 0, true, Symbol('sync')]) {
    expect(decodeListeningMode(value)).toEqual({ ok: false, code: 'invalid_field', field: '' });
  }
});
