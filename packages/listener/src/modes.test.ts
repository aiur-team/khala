import { expect, it } from 'vitest';
import { DEFAULT_LISTENING_MODE, DELIVERY_MODES, LISTENING_MODES, MODE_SUPPORT_STATUSES, decodeListeningMode } from './index';

it('keeps the strict mode vocabulary and sync default; mute has no delivery route', () => {
  expect(DEFAULT_LISTENING_MODE).toBe('sync');
  expect(LISTENING_MODES).toEqual(['steer', 'sync', 'async', 'mute']);
  expect(DELIVERY_MODES).toEqual(['steer', 'sync', 'async']);
  expect(MODE_SUPPORT_STATUSES).toEqual(['proven', 'experimental', 'blocked_without_wrapper', 'unsupported', 'unknown']);
  for (const value of LISTENING_MODES) expect(decodeListeningMode(value)).toEqual({ ok: true, value });
  for (const value of ['unknown', 'SYNC', undefined, null, {}, ['sync'], 0, true, Symbol('sync')]) {
    expect(decodeListeningMode(value)).toEqual({ ok: false, code: 'invalid_field', field: '' });
  }
});
