/** Limits refresh traffic while a connector cannot answer a mailbox read. */
export function createMailboxReadRetry() {
  const state = new Map<string, { nextAt: number; delayMs: number }>();
  return {
    ready(bindingId: string): boolean { return Date.now() >= (state.get(bindingId)?.nextAt ?? 0); },
    delay(bindingId: string): void {
      const delayMs = Math.min((state.get(bindingId)?.delayMs ?? 7_500) * 2, 60_000);
      state.set(bindingId, { nextAt: Date.now() + delayMs, delayMs });
    },
    clear(bindingId: string): void { state.delete(bindingId); },
  };
}
