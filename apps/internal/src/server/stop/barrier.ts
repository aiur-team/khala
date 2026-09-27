// The per-binding revocation barrier. Every authorized binding effect commits
// through `run`, which rechecks the barrier at the commit point itself, not when
// the request was authenticated. `raise` is terminal for one binding generation:
// once it returns, no effect for that generation can start committing. `drain`
// resolves once every effect that was already committing has settled, so Stop
// reports success only after earlier effects finished or failed.

export type BindingKey = Readonly<{ bindingId: string; generation: number }>;

export type BarrierRun<T> =
  | Readonly<{ kind: 'ran'; value: T }>
  | Readonly<{ kind: 'barred' }>;

export type RevocationBarrier = Readonly<{
  barred(key: BindingKey): boolean;
  /**
   * Commits one effect unless the binding is barred. A Promise-returning effect
   * stays in flight until it settles, and `drain` waits for it.
   */
  run<T>(key: BindingKey, effect: () => T): BarrierRun<T>;
  /** Bars the binding generation for good and ends its registered live streams. */
  raise(key: BindingKey): void;
  /** Resolves after every effect that began before `raise` has settled. */
  drain(key: BindingKey): Promise<void>;
  /** Registers a stream that must end when the binding is barred; returns its deregistration. */
  onRaise(key: BindingKey, listener: () => void): () => void;
}>;

function scope(key: BindingKey): string {
  return JSON.stringify([key.bindingId, key.generation]);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

export function createRevocationBarrier(): RevocationBarrier {
  const raised = new Set<string>();
  const inFlight = new Map<string, Set<Promise<unknown>>>();
  const listeners = new Map<string, Set<() => void>>();

  return {
    barred: key => raised.has(scope(key)),

    run(key, effect) {
      const id = scope(key);
      if (raised.has(id)) return { kind: 'barred' };
      const value = effect();
      if (isPromiseLike(value)) {
        const settled = Promise.resolve(value).then(() => undefined, () => undefined);
        const pending = inFlight.get(id) ?? new Set();
        pending.add(settled);
        inFlight.set(id, pending);
        void settled.then(() => {
          pending.delete(settled);
          if (pending.size === 0 && inFlight.get(id) === pending) inFlight.delete(id);
        });
      }
      return { kind: 'ran', value };
    },

    raise(key) {
      const id = scope(key);
      raised.add(id);
      const registered = listeners.get(id);
      listeners.delete(id);
      for (const listener of registered ?? []) {
        try { listener(); } catch { /* One stream's cleanup never blocks another's. */ }
      }
    },

    async drain(key) {
      const id = scope(key);
      for (;;) {
        const pending = inFlight.get(id);
        if (!pending || pending.size === 0) return;
        await Promise.all(pending);
      }
    },

    onRaise(key, listener) {
      const id = scope(key);
      if (raised.has(id)) {
        listener();
        return () => {};
      }
      const registered = listeners.get(id) ?? new Set();
      registered.add(listener);
      listeners.set(id, registered);
      return () => {
        registered.delete(listener);
        if (registered.size === 0 && listeners.get(id) === registered) listeners.delete(id);
      };
    },
  };
}
