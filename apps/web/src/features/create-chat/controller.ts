import type { Disposer, MessageContent, OperationResult, RoomId } from '@khala/contracts/messaging';
import { INITIAL_VIEW, type CreateChatView } from './model';
import type { CreateChatPorts } from './ports';

type JournalPorts = Pick<CreateChatPorts, 'room' | 'admission'>;

/** Which in-flight step `retry()` resumes; never exposed on the view. */
type PendingStep = 'create' | 'intro' | 'share' | null;

export interface CreateChatController {
  getView(): CreateChatView;
  subscribe(listener: (view: CreateChatView) => void): Disposer;
  setTitle(title: string): void;
  addIntro(): void;
  updateIntro(localId: string, body: string): void;
  removeIntro(localId: string): void;
  reorderIntro(localId: string, direction: 'up' | 'down'): void;
  submit(): void;
  retry(): void;
  dispose(): void;
}

const defaultCreateId = (): string =>
  typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

export function createChatController(
  ports: JournalPorts,
  options: Readonly<{ createId?: () => string }> = {},
): CreateChatController {
  const createId = options.createId ?? defaultCreateId;

  let view: CreateChatView = INITIAL_VIEW;
  let disposed = false;
  const listeners = new Set<(view: CreateChatView) => void>();

  // Operation identity persists across retries so a resumed step never resends
  // already-accepted work; only editing before the room exists clears them.
  let operationId: string | null = null;
  let batchId: string | null = null;
  let shareOperationId: string | null = null;
  let pendingStep: PendingStep = null;

  function notify(): void {
    if (disposed) return;
    for (const listener of listeners) listener(view);
  }

  function setPhase(phase: CreateChatView['phase']): void {
    view = { ...view, phase, errorCode: null };
    notify();
  }

  function setFailed(errorCode: string): void {
    view = { ...view, phase: 'failed', errorCode };
    notify();
  }

  function applyEdit(mutate: (current: CreateChatView) => CreateChatView): void {
    if (disposed) return;
    if (view.phase === 'failed' && view.roomId === null) {
      // A rejection before the room exists means the input itself was refused;
      // editing it starts a fresh operation rather than resuming a dead one.
      view = { ...view, phase: 'editing', errorCode: null };
      operationId = null;
    }
    if (view.phase !== 'editing') return;
    view = mutate(view);
    notify();
  }

  /**
   * Runs one journal step and dispatches its `OperationResult`: `ok` continues
   * into `onOk`, `rejected`/`unavailable` fail the step, `outcome_unknown` moves
   * to `resolving` for an explicit retry. A thrown rejection (not an
   * `OperationResult`) is treated the same as `unavailable`, so a step never
   * leaves the UI stuck busy.
   */
  async function runStep<T>(step: PendingStep, run: () => Promise<OperationResult<T, string>>, onOk: (value: T) => void | Promise<void>): Promise<void> {
    pendingStep = step;
    try {
      const result = await run();
      if (disposed) return;
      if (result.kind === 'ok') await onOk(result.value);
      else if (result.kind === 'rejected') setFailed(result.code);
      else if (result.kind === 'unavailable') setFailed('unavailable');
      else setPhase('resolving');
    } catch {
      if (!disposed) setFailed('unavailable');
    }
  }

  async function attemptCreate(): Promise<void> {
    setPhase('creating');
    const title = view.title.trim() === '' ? null : view.title;
    await runStep('create', () => ports.room.create({ operationId: operationId!, title }), async value => {
      view = { ...view, roomId: value.roomId };
      if (view.intros.length === 0) await attemptShare();
      else await attemptIntro(false);
    });
  }

  async function attemptIntro(resume: boolean): Promise<void> {
    setPhase('preparing_intro');
    const roomId = view.roomId as RoomId;
    batchId ??= createId();
    await runStep(
      'intro',
      () =>
        resume
          ? ports.room.resumeIntro(batchId!)
          : ports.room.prepareIntro({
              roomId,
              batchId: batchId!,
              messages: view.intros.map((intro): MessageContent => ({ v: 1, kind: 'text', body: intro.body })),
            }),
      async states => {
        if (states.some(state => state.state === 'outcome_unknown' || state.state === 'pending')) {
          setPhase('resolving');
          return;
        }
        if (states.some(state => state.state === 'failed')) {
          setFailed('intro_failed');
          return;
        }
        await attemptShare();
      },
    );
  }

  async function attemptShare(): Promise<void> {
    setPhase('sharing');
    // Cleared unconditionally: a stale prior share URL must never survive into
    // a failed or resolving outcome, only a freshly confirmed `ok`.
    view = { ...view, shareUrl: null };
    const roomId = view.roomId as RoomId;
    shareOperationId ??= createId();
    await runStep('share', () => ports.admission.share({ operationId: shareOperationId!, roomId }), value => {
      view = { ...view, shareUrl: value.shareUrl };
      setPhase('ready');
    });
  }

  return {
    getView: () => view,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    setTitle(title) {
      applyEdit(current => ({ ...current, title }));
    },

    addIntro() {
      applyEdit(current => ({ ...current, intros: [...current.intros, { localId: createId(), body: '' }] }));
    },

    updateIntro(localId, body) {
      applyEdit(current => ({
        ...current,
        intros: current.intros.map(intro => (intro.localId === localId ? { ...intro, body } : intro)),
      }));
    },

    removeIntro(localId) {
      applyEdit(current => ({ ...current, intros: current.intros.filter(intro => intro.localId !== localId) }));
    },

    reorderIntro(localId, direction) {
      applyEdit(current => {
        const index = current.intros.findIndex(intro => intro.localId === localId);
        if (index === -1) return current;
        const swapWith = direction === 'up' ? index - 1 : index + 1;
        if (swapWith < 0 || swapWith >= current.intros.length) return current;
        const intros = [...current.intros];
        const a = intros[index]!;
        const b = intros[swapWith]!;
        intros[index] = b;
        intros[swapWith] = a;
        return { ...current, intros };
      });
    },

    submit() {
      if (disposed || view.phase !== 'editing') return;
      // Double submit is a no-op: phase leaves 'editing' before the first await,
      // and operationId is only ever assigned once per room.
      operationId ??= createId();
      void attemptCreate();
    },

    retry() {
      if (disposed) return;
      if (view.phase !== 'failed' && view.phase !== 'resolving') return;
      view = { ...view, errorCode: null };
      if (pendingStep === 'create') void attemptCreate();
      else if (pendingStep === 'intro') void attemptIntro(true);
      else if (pendingStep === 'share') void attemptShare();
    },

    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}
