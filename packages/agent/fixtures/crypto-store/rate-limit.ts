import { setTimeout as delay } from 'node:timers/promises';

export async function rateLimitSafe<T>(operation: () => Promise<T>): Promise<T> {
  for (let retries = 0; ; retries++) {
    try { return await operation(); }
    catch (error) {
      const limit = error as { errcode?: string; data?: { retry_after_ms?: number } };
      if (limit.errcode !== 'M_LIMIT_EXCEEDED' || retries >= 10) throw error;
      await delay(Math.max(100, limit.data?.retry_after_ms ?? 1000));
    }
  }
}
