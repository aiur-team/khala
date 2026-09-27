import {
  type ExperimentalRoute, type ListeningBinding, type ListeningFailure, type ListeningModeName, type ListeningPort, currentGrant, grantableRoute,
} from './listening-port';

/** The experimental route the owner is reviewing, pinned to the exact evidence shown to them. */
export type GrantConfirmation = Readonly<{
  bindingId: string;
  generation: number;
  displayName: string;
  route: ExperimentalRoute;
  evidenceRef: string | null;
  /** What Khala has not proved about this route, from the harness claim. */
  missingProof: string | null;
}>;

export type ListeningView = Readonly<{
  phase: 'loading' | 'ready' | 'failed';
  bindings: readonly ListeningBinding[];
  /** The binding whose change is in flight; every control for it is disabled meanwhile. */
  busy: string | null;
  /** The latest outcome, announced once; empty until something happened. */
  notice: string;
  failure: ListeningFailure | null;
  /** The open experimental-route confirmation, or `null`. Nothing is granted until the owner confirms it. */
  confirmation: GrantConfirmation | null;
}>;

export type ListeningController = Readonly<{
  getView(): ListeningView;
  subscribe(listener: () => void): () => void;
  /** Rereads every binding's mode and pause from the server. */
  refresh(): Promise<void>;
  setMode(bindingId: string, requested: ListeningModeName): Promise<void>;
  setPaused(bindingId: string, paused: boolean): Promise<void>;
  /** Opens the confirmation for `mode`'s experimental route; it grants nothing by itself. */
  requestGrant(bindingId: string, mode: ListeningModeName): void;
  /** Grants exactly the route the open confirmation shows. */
  confirmGrant(): Promise<void>;
  cancelGrant(): void;
  /** Revokes the owner's grant for `mode`, current or stale. */
  revokeGrant(bindingId: string, mode: ListeningModeName): Promise<void>;
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

const sameRoute = (a: ExperimentalRoute, b: ExperimentalRoute) =>
  a.mode === b.mode && a.route === b.route && a.harnessVersion === b.harnessVersion && a.evidenceRevision === b.evidenceRevision;

export function createListeningController(port: ListeningPort, channelId: string): ListeningController {
  let view: ListeningView = { phase: 'loading', bindings: [], busy: null, notice: '', failure: null, confirmation: null };
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
    if (listed.kind === 'listed') {
      set({ phase: 'ready', bindings: listed.bindings });
      // A confirmation stays open only while the evidence it shows is still the binding's current claim.
      const open = view.confirmation;
      if (open !== null) {
        const binding = listed.bindings.find(candidate => candidate.bindingId === open.bindingId && candidate.generation === open.generation);
        const current = binding ? grantableRoute(binding, open.route.mode) : null;
        if (current === null || !sameRoute(current, open.route)) {
          set({
            confirmation: null,
            notice: `The evidence for ${open.displayName} changed while you were reviewing it. Review the updated evidence before confirming.`,
          });
        }
      }
    }
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
    requestGrant(bindingId, mode) {
      const binding = view.bindings.find(candidate => candidate.bindingId === bindingId);
      const route = binding ? grantableRoute(binding, mode) : null;
      if (!binding || route === null || view.busy !== null) return;
      const support = binding.support[mode];
      set({
        confirmation: {
          bindingId, generation: binding.generation, displayName: binding.displayName, route,
          evidenceRef: support.evidenceRef, missingProof: support.reason,
        },
        notice: '',
      });
    },
    async confirmGrant() {
      const open = view.confirmation;
      if (open === null) return;
      set({ confirmation: null });
      const { route } = open;
      await change(open.bindingId,
        // Pinned to the generation the owner reviewed; a newer binding generation is never granted by an older view.
        binding => (binding.generation === open.generation
          ? port.changeExperimentalRoute(channelId, binding, 'grant', route)
          : Promise.resolve({ kind: 'failed', reason: 'conflict' })),
        binding => `Experimental route for ${LABELS[route.mode]} on ${binding.displayName} granted.`);
    },
    cancelGrant() {
      if (view.confirmation !== null) set({ confirmation: null });
    },
    revokeGrant: (bindingId, mode) => change(bindingId,
      binding => {
        // The grant in effect first; otherwise the stale one the owner is looking at.
        const grant = currentGrant(binding, mode) ?? binding.experimentalGrants.find(candidate => candidate.mode === mode);
        return grant
          ? port.changeExperimentalRoute(channelId, binding, 'revoke', grant)
          : Promise.resolve({ kind: 'failed', reason: 'conflict' });
      },
      binding => `Experimental route for ${LABELS[mode]} on ${binding.displayName} revoked.`),
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}
