import type { ContentLimits, Disposer, MessageContent, OperationResult, RoomId } from '@khala/contracts/messaging/index';
import { INITIAL_VIEW, type CreateChatView, type IntroDraft } from './model';
import type { CreateChatPorts } from './ports';

type JournalPorts = Pick<CreateChatPorts, 'room' | 'admission' | 'limits'>;

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

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Local pre-check only; the server remains authoritative for every rule it enforces. */
function validateTitle(title: string, limits: ContentLimits): string | null {
  return byteLength(title) > limits.maxRoomTitleBytes ? 'title_too_long' : null;
}

/** An intro that is empty after trimming is never sent as a message. */
function validateIntroBody(body: string, limits: ContentLimits): string | null {
  if (body.trim().length === 0) return 'message_empty';
  if (byteLength(body) > limits.maxBodyBytes) return 'message_too_long';
  return null;
}

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
  let frozenIntros: readonly MessageContent[] | null = null;
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

  /**
   * A rejection of the intro batch that reached the server is a rejection of that
   * batch's exact content, not of the room. The room and title stay put; the intro
   * drafts unlock so the human can fix them, and the next attempt starts a fresh
   * batch (so edited content never collides with the old batch's journal entry).
   */
  function reopenIntroEditing(errorCode: string): void {
    batchId = null;
    frozenIntros = null;
    view = { ...view, phase: 'editing', errorCode };
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
   * into `onOk`, `outcome_unknown` moves to `resolving` for an explicit retry.
   * A `rejected` intro batch that already reached the server (room exists)
   * reopens intro editing instead of dead-ending; every other rejection, and
   * `unavailable`, fail the step. A thrown rejection (not an `OperationResult`)
   * is treated the same as `unavailable`, so a step never leaves the UI stuck busy.
   */
  async function runStep<T>(step: PendingStep, run: () => Promise<OperationResult<T, string>>, onOk: (value: T) => void | Promise<void>): Promise<void> {
    pendingStep = step;
    try {
      const result = await run();
      if (disposed) return;
      if (result.kind === 'ok') await onOk(result.value);
      else if (result.kind === 'rejected') {
        if (step === 'intro' && view.roomId !== null) reopenIntroEditing(result.code);
        else setFailed(result.code);
      } else if (result.kind === 'unavailable') setFailed('unavailable');
      else setPhase('resolving');
    } catch {
      if (!disposed) setFailed('unavailable');
    }
  }

  async function attemptCreate(): Promise<void> {
    setPhase('creating');
    const title = view.title === '' ? null : view.title;
    await runStep('create', () => ports.room.create({ operationId: operationId!, title }), async value => {
      view = { ...view, roomId: value.roomId };
      if (view.intros.length === 0) await attemptShare();
      else await attemptIntro();
    });
  }

  /**
   * Always prepares (never resumes) the batch: the room command treats an
   * identical `batchId` + identical message bytes as a resume of the same
   * batch, so re-preparing is safe whether or not the prior attempt's intent
   * ever reached the journal (a batch rejected before the journal write, for
   * example on oversized content, has nothing for `resumeIntro` to find).
   */
  async function attemptIntro(): Promise<void> {
    setPhase('preparing_intro');
    const roomId = view.roomId as RoomId;
    batchId ??= createId();
    frozenIntros ??= view.intros.map((intro): MessageContent => ({ v: 1, kind: 'text', body: intro.body }));
    const messages = frozenIntros;
    await runStep(
      'intro',
      () => ports.room.prepareIntro({ roomId, batchId: batchId!, messages }),
      async states => {
        if (states.length !== messages.length || states.some(state => state.state === 'outcome_unknown' || state.state === 'pending')) {
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
      applyEdit(current => ({ ...current, title, titleError: null }));
    },

    addIntro() {
      applyEdit(current => ({ ...current, intros: [...current.intros, { localId: createId(), body: '', error: null }] }));
    },

    updateIntro(localId, body) {
      applyEdit(current => ({
        ...current,
        intros: current.intros.map(intro => (intro.localId === localId ? { ...intro, body, error: null } : intro)),
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
      const title = view.title.trim();
      const titleError = validateTitle(title, ports.limits);
      const intros: readonly IntroDraft[] = view.intros.map(intro => ({ ...intro, error: validateIntroBody(intro.body, ports.limits) }));
      if (titleError !== null || intros.some(intro => intro.error !== null)) {
        view = { ...view, title, titleError, intros };
        notify();
        return;
      }
      view = { ...view, title, titleError: null, intros };
      // Double submit is a no-op: phase leaves 'editing' before the first await,
      // and operationId is only ever assigned once per room.
      if (view.roomId !== null) {
        // The room and title already exist; only the intro batch is retried.
        void attemptIntro();
        return;
      }
      operationId ??= createId();
      void attemptCreate();
    },

    retry() {
      if (disposed) return;
      if (view.phase !== 'failed' && view.phase !== 'resolving') return;
      view = { ...view, errorCode: null };
      if (pendingStep === 'create') void attemptCreate();
      else if (pendingStep === 'intro') void attemptIntro();
      else if (pendingStep === 'share') void attemptShare();
    },

    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}
