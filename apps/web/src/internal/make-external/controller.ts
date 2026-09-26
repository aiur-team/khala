// State holder for the Make-external page. It reads the server's journey view, sends
// one action at a time, and keeps asking the server to continue while a step advances
// on its own. An action whose outcome is unknown is resent with the same operation ID,
// so a retry is never a second action.

import type { MakeExternalAction, MakeExternalActionKind, MakeExternalJourneyView } from '@khala/contracts/messaging/make-external';
import { REJECTION_MESSAGE, STEP_ANNOUNCEMENT, historyProgressText, stepAdvancesAlone, stepOf } from './model';
import type { MakeExternalPort } from './port';

type Distribute<T> = T extends unknown ? Omit<T, 'operationId'> : never;
export type JourneyActionInput = Distribute<MakeExternalAction>;

export type MakeExternalState = Readonly<{
  phase: 'loading' | 'ready' | 'absent' | 'session_ended' | 'load_failed';
  view: MakeExternalJourneyView | null;
  /** The action in flight; controls stay focusable but do nothing twice. */
  busy: MakeExternalActionKind | null;
  /** Latest polite announcement. */
  announcement: string;
  /** Latest failure, announced assertively. */
  error: string | null;
  /** An action whose outcome is unknown and can be resent as the same operation. */
  retryable: boolean;
}>;

export interface MakeExternalController {
  getState(): MakeExternalState;
  subscribe(listener: (state: MakeExternalState) => void): () => void;
  start(): void;
  act(action: JourneyActionInput): Promise<void>;
  /** Resends the last action whose outcome was unknown, with its operation ID. */
  retry(): Promise<void>;
  dispose(): void;
}

export type MakeExternalControllerOptions = Readonly<{
  createId?: () => string;
  pollMs?: number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}>;

const INITIAL: MakeExternalState = { phase: 'loading', view: null, busy: null, announcement: '', error: null, retryable: false };

const UNKNOWN = 'Khala could not confirm that step. Try again: it will not happen twice.';
const UNAVAILABLE = 'The local Khala server did not answer. It keeps your conversion; try again.';

export function createMakeExternalController(
  port: MakeExternalPort, channelId: string, options: MakeExternalControllerOptions = {},
): MakeExternalController {
  const createId = options.createId ?? (() => crypto.randomUUID());
  const pollMs = options.pollMs ?? 1_500;
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const listeners = new Set<(state: MakeExternalState) => void>();
  let state = INITIAL;
  let disposed = false;
  let timer: unknown = null;
  let pending: MakeExternalAction | null = null;
  let polling = false;

  function set(next: MakeExternalState): void {
    if (disposed) return;
    state = next;
    for (const listener of listeners) listener(state);
    schedule();
  }

  /** The announcement for a view change: a new step, or new history progress on the same step. */
  function announce(previous: MakeExternalJourneyView | null, next: MakeExternalJourneyView): string | null {
    const step = stepOf(next);
    if (previous === null || stepOf(previous) !== step) return STEP_ANNOUNCEMENT[step];
    const progress = historyProgressText(next);
    return progress !== null && progress !== historyProgressText(previous) ? progress : null;
  }

  function show(view: MakeExternalJourneyView, extra: Partial<MakeExternalState> = {}): void {
    const announcement = announce(state.view, view);
    set({ ...state, phase: 'ready', view, announcement: announcement ?? state.announcement, ...extra });
  }

  function schedule(): void {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (disposed || state.phase !== 'ready' || state.busy !== null || state.retryable || state.view === null) return;
    if (!stepAdvancesAlone(stepOf(state.view))) return;
    timer = setTimer(() => {
      timer = null;
      void poll();
    }, pollMs);
  }

  /** Asks the server to continue; silent unless the step or progress changed. */
  async function poll(): Promise<void> {
    if (disposed || polling || state.view === null) return;
    polling = true;
    try {
      if (stepOf(state.view) === 'signing_in') {
        const read = await port.view(channelId);
        if (read.kind === 'ok') show(read.view);
        else if (read.kind === 'session_ended') set({ ...state, phase: 'session_ended' });
        else schedule();
        return;
      }
      const written = await port.act(channelId, { kind: 'resume', operationId: createId() });
      if (written.kind === 'ok') show(written.view);
      else if (written.kind === 'session_ended') set({ ...state, phase: 'session_ended' });
      else schedule();
    } finally {
      polling = false;
    }
  }

  async function send(action: MakeExternalAction): Promise<void> {
    pending = action;
    set({ ...state, busy: action.kind, error: null, retryable: false });
    const written = await port.act(channelId, action);
    if (disposed) return;
    switch (written.kind) {
      case 'ok':
        pending = null;
        show(written.view, {
          busy: null,
          error: written.rejection === null ? null : REJECTION_MESSAGE[written.rejection],
        });
        return;
      case 'outcome_unknown':
        set({ ...state, busy: null, error: UNKNOWN, retryable: true });
        return;
      case 'session_ended':
        set({ ...state, busy: null, phase: 'session_ended' });
        return;
      case 'absent':
        set({ ...state, busy: null, phase: 'absent' });
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      void (async () => {
        const read = await port.view(channelId);
        if (disposed) return;
        if (read.kind === 'ok') show(read.view);
        else if (read.kind === 'absent') set({ ...state, phase: 'absent' });
        else if (read.kind === 'session_ended') set({ ...state, phase: 'session_ended' });
        else set({ ...state, phase: 'load_failed', error: UNAVAILABLE });
      })();
    },
    async act(action) {
      if (state.busy !== null) return;
      await send({ ...action, operationId: createId() } as MakeExternalAction);
    },
    async retry() {
      if (state.busy !== null) return;
      if (pending !== null && state.retryable) {
        await send(pending);
        return;
      }
      // Nothing to resend: reload the view.
      set({ ...state, phase: state.view === null ? 'loading' : state.phase, error: null });
      const read = await port.view(channelId);
      if (read.kind === 'ok') show(read.view);
      else if (read.kind !== 'absent' && read.kind !== 'session_ended') set({ ...state, phase: state.view ? 'ready' : 'load_failed', error: UNAVAILABLE });
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimer(timer);
      listeners.clear();
    },
  };
}
