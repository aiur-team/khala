import type { BindingStopPort, RemainingBinding, StopFailure, StoppedBinding } from './stop-port';

export type StopView =
  | Readonly<{ phase: 'idle' }>
  | Readonly<{ phase: 'confirming' }>
  | Readonly<{ phase: 'stopping' }>
  | Readonly<{ phase: 'stopped'; stopped: readonly StoppedBinding[] }>
  | Readonly<{ phase: 'partial'; stopped: readonly StoppedBinding[]; remaining: readonly RemainingBinding[] }>
  | Readonly<{ phase: 'failed'; reason: StopFailure }>;

export type StopController = Readonly<{
  getView(): StopView;
  subscribe(listener: () => void): () => void;
  /** Opens the confirmation. Ignored while a Stop is in flight. */
  request(): void;
  cancel(): void;
  /** Sends one Stop. A second call while one is in flight is ignored, so Stop is never submitted twice. */
  confirm(): void;
  /** Resends Stop after a partial or failed outcome; the server treats it idempotently. */
  retry(): void;
  dispose(): void;
}>;

export function createStopController(port: BindingStopPort, channelId: string): StopController {
  let view: StopView = { phase: 'idle' };
  let disposed = false;
  const listeners = new Set<() => void>();
  const set = (next: StopView) => {
    if (disposed) return;
    view = next;
    for (const listener of listeners) listener();
  };

  async function send(): Promise<void> {
    set({ phase: 'stopping' });
    let outcome: Awaited<ReturnType<BindingStopPort['stop']>>;
    try {
      outcome = await port.stop(channelId);
    } catch {
      outcome = { kind: 'failed', reason: 'unavailable' };
    }
    if (outcome.kind === 'stopped') set({ phase: 'stopped', stopped: outcome.stopped });
    else if (outcome.kind === 'partial') set({ phase: 'partial', stopped: outcome.stopped, remaining: outcome.remaining });
    else set({ phase: 'failed', reason: outcome.reason });
  }

  return {
    getView: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    request() {
      if (view.phase !== 'stopping') set({ phase: 'confirming' });
    },
    cancel() {
      if (view.phase === 'confirming') set({ phase: 'idle' });
    },
    confirm() {
      if (view.phase === 'confirming') void send();
    },
    retry() {
      if (view.phase === 'partial' || view.phase === 'failed') void send();
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}
