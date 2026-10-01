export function browserSessionStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try { return globalThis.sessionStorage ?? null; } catch { return null; }
}

/** Limits refresh traffic while a connector cannot answer a mailbox read. */
export function createMailboxReadRetry(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null,
  prefix: string) {
  const state = new Map<string, { nextAt: number; delayMs: number }>();
  const key = (bindingId: string) => `${prefix}:retry:${bindingId}`;
  function current(bindingId: string): { nextAt: number; delayMs: number } | null {
    const inMemory = state.get(bindingId);
    if (inMemory) return inMemory;
    try {
      const raw = storage?.getItem(key(bindingId));
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (typeof parsed !== 'object' || parsed === null || !('nextAt' in parsed) || !('delayMs' in parsed)
        || typeof parsed.nextAt !== 'number' || !Number.isFinite(parsed.nextAt)
        || typeof parsed.delayMs !== 'number' || parsed.delayMs < 15_000 || parsed.delayMs > 60_000) return null;
      const value = { nextAt: parsed.nextAt, delayMs: parsed.delayMs };
      state.set(bindingId, value);
      return value;
    } catch { return null; }
  }
  return {
    ready(bindingId: string): boolean { return Date.now() >= (current(bindingId)?.nextAt ?? 0); },
    delay(bindingId: string): void {
      const delayMs = Math.min((current(bindingId)?.delayMs ?? 7_500) * 2, 60_000);
      const value = { nextAt: Date.now() + delayMs, delayMs };
      state.set(bindingId, value);
      try { storage?.setItem(key(bindingId), JSON.stringify(value)); } catch { /* In-memory backoff remains. */ }
    },
    clear(bindingId: string): void {
      state.delete(bindingId);
      try { storage?.removeItem(key(bindingId)); } catch { /* Expired state is harmless. */ }
    },
  };
}
