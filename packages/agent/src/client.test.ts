import { expect, it } from 'vitest';
import { KhalaClientError } from './client';

it('exposes a stable code and defaults the message to it', () => {
  const error = new KhalaClientError('join_expired');
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ code: 'join_expired', message: 'join_expired', name: 'KhalaClientError' });
  expect(new KhalaClientError('send_failed', 'custom').message).toBe('custom');
});
