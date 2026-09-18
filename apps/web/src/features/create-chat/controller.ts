import type { Disposer, MessageContent, RoomId } from '@khala/contracts/messaging';
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

  async function attemptCreate(): Promise<void> {
    setPhase('creating');
    const title = view.title.trim() === '' ? null : view.title;
    const result = await ports.room.create({ operationId: operationId!, title });
    if (disposed) return;
    if (result.kind === 'ok') {
      view = { ...view, roomId: result.value.roomId };
      if (view.intros.length === 0) await attemptShare();
      else await attemptIntro(false);
    } else if (result.kind === 'rejected') {
      pendingStep = 'create';
      setFailed(result.code);
    } else if (result.kind === 'unavailable') {
      pendingStep = 'create';
      setFailed('unavailable');
    } else {
      pendingStep = 'create';
      setPhase('resolving');
    }
  }

  async function attemptIntro(resume: boolean): Promise<void> {
    setPhase('preparing_intro');
    const roomId = view.roomId as RoomId;
    batchId ??= createId();
    const result = resume
      ? await ports.room.resumeIntro(batchId)
      : await ports.room.prepareIntro({
          roomId,
          batchId,
          messages: view.intros.map((intro): MessageContent => ({ v: 1, kind: 'text', body: intro.body })),
        });
    if (disposed) return;
    if (result.kind === 'ok') {
      const states = result.value;
      if (states.some(state => state.state === 'outcome_unknown' || state.state === 'pending')) {
        pendingStep = 'intro';
        setPhase('resolving');
        return;
      }
      if (states.some(state => state.state === 'failed')) {
        pendingStep = 'intro';
        setFailed('intro_failed');
        return;
      }
      await attemptShare();
    } else if (result.kind === 'rejected') {
      pendingStep = 'intro';
      setFailed(result.code);
    } else if (result.kind === 'unavailable') {
      pendingStep = 'intro';
      setFailed('unavailable');
    } else {
      pendingStep = 'intro';
      setPhase('resolving');
    }
  }

  async function attemptShare(): Promise<void> {
    setPhase('sharing');
    const roomId = view.roomId as RoomId;
    shareOperationId ??= createId();
    const result = await ports.admission.share({ operationId: shareOperationId, roomId });
    if (disposed) return;
    if (result.kind === 'ok') {
      view = { ...view, shareUrl: result.value.shareUrl };
      setPhase('ready');
    } else if (result.kind === 'rejected') {
      pendingStep = 'share';
      view = { ...view, shareUrl: null };
      setFailed(result.code);
    } else if (result.kind === 'unavailable') {
      pendingStep = 'share';
      setFailed('unavailable');
    } else {
      pendingStep = 'share';
      setPhase('resolving');
    }
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
