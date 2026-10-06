import { expect, it, vi } from 'vitest';
const delay = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('node:timers/promises', () => ({ setTimeout: delay }));
import { rateLimitSafe } from '../../fixtures/crypto-store/rate-limit';

it('honours Synapse retry_after_ms and completes the rejected operation', async () => {
  delay.mockClear();
  const operation = vi.fn().mockRejectedValueOnce({ errcode: 'M_LIMIT_EXCEEDED', data: { retry_after_ms: 2345 } }).mockResolvedValue('done');
  expect(await rateLimitSafe(operation)).toBe('done');
  expect(delay).toHaveBeenCalledExactlyOnceWith(2345);
  expect(operation).toHaveBeenCalledTimes(2);
});
it('bounds rate-limit retries and propagates other failures immediately', async () => {
  delay.mockClear();
  const error = { errcode: 'M_LIMIT_EXCEEDED' };
  const limited = vi.fn().mockRejectedValue(error);
  await expect(rateLimitSafe(limited)).rejects.toBe(error);
  expect(limited).toHaveBeenCalledTimes(11);
  expect(delay).toHaveBeenCalledTimes(10);
  const forbidden = { errcode: 'M_FORBIDDEN' };
  const failed = vi.fn().mockRejectedValue(forbidden);
  await expect(rateLimitSafe(failed)).rejects.toBe(forbidden);
  expect(failed).toHaveBeenCalledOnce();
});

it('reports HTTP status for non-JSON error pages and retains Matrix retry metadata', async () => {
  const { proofRequest } = await import('../../fixtures/crypto-store/request');
  const fetcher = vi.spyOn(globalThis, 'fetch');
  try {
    fetcher.mockResolvedValueOnce(new Response('<html>unavailable</html>', { status: 502 }));
    await expect(proofRequest('https://hs', '/test')).rejects.toThrow('request_502');
    fetcher.mockResolvedValueOnce(Response.json({ errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 1234 }, { status: 429 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    expect(await proofRequest('https://hs', '/test')).toEqual({ ok: true });
    expect(delay).toHaveBeenLastCalledWith(1234);
  } finally { fetcher.mockRestore(); }
});
