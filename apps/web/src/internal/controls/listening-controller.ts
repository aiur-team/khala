import type { ListeningBinding, ListeningFailure, ListeningModeName, ListeningPort } from './listening-port';

export type ListeningView = Readonly<{
  phase: 'loading' | 'ready' | 'failed';
  bindings: readonly ListeningBinding[];
  /** The binding whose change is in flight; every control for it is disabled meanwhile. */
  busy: string | null;
  /** The latest outcome, announced once; empty until something happened. */
  notice: string;
  failure: ListeningFailure | null;
}>;

export type ListeningController = Readonly<{
  getView(): ListeningView;
  subscribe(listener: () => void): () => void;
  /** Rereads every binding's mode and pause from the server. */
  refresh(): Promise<void>;
  setMode(bindingId: string, requested: ListeningModeName): Promise<void>;
  setPaused(bindingId: string, paused: boolean): Promise<void>;
  dispose(): void;
}>;

const LABELS: Record<ListeningModeName, string> = { steer: 'Steer', sync: 'Sync', async: 'Async' };

export const FAILURE_TEXT: Record<ListeningFailure, string> = {
  unavailable: 'Khala could not reach the local server. Nothing changed. Try again.',
  session_ended: 'This local session has ended. Relaunch Khala from your terminal.',
  forbidden: 'This session cannot change that agent. It may have been stopped.',
  conflict: 'That agent changed while you were choosing. The current state is shown; choose again.',
  outcome_unknown: 'Khala could not confirm the change. The current state is shown; check it before trying again.',
};

export function createListeningController(port: ListeningPort, channelId: string): ListeningController {
  let view: ListeningView = { phase: 'loading', bindings: [], busy: null, notice: '', failure: null };
  let disposed = false;
  const listeners = new Set<() => void>();
  const set = (next: Partial<ListeningView>) => {
    if (disposed) return;
    view = { ...view, ...next };
    for (const listener of listeners) listener();
  };

  async function refresh(): Promise<void> {
    let listed: Awaited<ReturnType<ListeningPort['list']>>;
    try { listed = await port.list(channelId); } catch { listed = { kind: 'failed', reason: 'unavailable' }; }
    if (listed.kind === 'listed') set({ phase: 'ready', bindings: listed.bindings });
    // A failed reread keeps the last state the owner saw, but never claims it is current.
    else set({ phase: view.phase === 'loading' ? 'failed' : view.phase, failure: listed.reason });
  }

  async function change(bindingId: string, run: (binding: ListeningBinding) => ReturnType<ListeningPort['setMode']>, done: (binding: ListeningBinding) => string) {
    const binding = view.bindings.find(candidate => candidate.bindingId === bindingId);
    if (!binding || view.busy !== null) return;
    set({ busy: bindingId, notice: '', failure: null });
    let outcome: Awaited<ReturnType<ListeningPort['setMode']>>;
    try { outcome = await run(binding); } catch { outcome = { kind: 'failed', reason: 'outcome_unknown' }; }
    // The server's state is reread either way, so the page never shows a guess.
    await refresh();
    set(outcome.kind === 'done'
      ? { busy: null, notice: done(binding), failure: null }
      : { busy: null, notice: FAILURE_TEXT[outcome.reason], failure: outcome.reason });
  }

  return {
    getView: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    setMode: (bindingId, requested) => change(bindingId,
      binding => port.setMode(channelId, binding, requested),
      binding => `${binding.displayName}: ${LABELS[requested]} requested.`),
    setPaused: (bindingId, paused) => change(bindingId,
      binding => port.setPaused(channelId, binding, paused),
      binding => (paused
        ? `Delivery to ${binding.displayName} is paused. New messages wait until you resume.`
        : `Delivery to ${binding.displayName} resumed.`)),
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}
