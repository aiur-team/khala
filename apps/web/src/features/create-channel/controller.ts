import type { AdmissionPolicy, ContentLimits, Disposer, OperationResult, RoomId } from '@khala/contracts/messaging/index';
import { decodeWith, displayText } from '@khala/contracts/messaging/decode';
import { INITIAL_VIEW, type AdmissionPolicyChoice, type CreateChannelView } from './model';
import type { CreateChannelPorts } from './ports';

type JournalPorts = Pick<CreateChannelPorts, 'room' | 'admission' | 'limits'>;

/**
 * `shared` (hosted) ends by minting a share link through the admission port.
 * `on_demand` opens the hosted channel without minting an invite; its channel
 * page mints one only when the owner asks to share. `private` omits admission.
 */
export type CreateChannelMode = 'shared' | 'on_demand' | 'private';

/** Which in-flight step `retry()` resumes; never exposed on the view. */
type PendingStep = 'create' | 'share' | null;

export interface CreateChannelController {
  getView(): CreateChannelView;
  subscribe(listener: (view: CreateChannelView) => void): Disposer;
  setTitle(title: string): void;
  setAdmissionPolicy(policy: AdmissionPolicyChoice): void;
  setNamedEmail(email: string): void;
  submit(): void;
  retry(): void;
  dispose(): void;
}

/** @deprecated Use `CreateChannelController`. Kept through the first tagged release containing #163. */
export type CreateChatController = CreateChannelController;

const defaultCreateId = (): string =>
  typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

/**
 * Local pre-check using the contract's own channel-title rules (`displayText`):
 * byte limit, no control characters, and no bidi or invisible characters that
 * let one label impersonate another. The server remains authoritative.
 */
function validateTitle(title: string, limits: ContentLimits): string | null {
  const checked = decodeWith(() => displayText(title, 'title', limits.maxRoomTitleBytes));
  if (checked.ok) return null;
  return checked.error.code === 'too_long' ? 'title_too_long' : 'title_invalid';
}

// Keep this local pre-check aligned with the authoritative normalization in
// apps/control/src/invitations/policy.ts.
const EMAIL = /^[^\s@]+@[^\s@]+$/;

function selectedPolicy(view: CreateChannelView): AdmissionPolicy {
  if (view.admissionPolicy === 'link_full_history') return { v: 1, kind: 'link', history: 'full' };
  if (view.admissionPolicy === 'named_no_history') {
    return { v: 1, kind: 'named_email', email: view.namedEmail.trim(), history: 'none' };
  }
  return { v: 1, kind: 'link', history: 'none' };
}

export function createCreateChannelController(
  ports: JournalPorts,
  options: Readonly<{ createId?: () => string; mode?: CreateChannelMode }> = {},
): CreateChannelController {
  const createId = options.createId ?? defaultCreateId;
  const mode = options.mode ?? 'shared';

  let view: CreateChannelView = INITIAL_VIEW;
  let disposed = false;
  const listeners = new Set<(view: CreateChannelView) => void>();

  // Operation identity persists across retries so a resumed step never resends
  // already-accepted work; only editing before the channel exists clears them.
  let operationId: string | null = null;
  let shareOperationId: string | null = null;
  let frozenPolicy: AdmissionPolicy | null = null;
  let pendingStep: PendingStep = null;

  function notify(): void {
    if (disposed) return;
    for (const listener of listeners) listener(view);
  }

  function setPhase(phase: CreateChannelView['phase']): void {
    view = { ...view, phase, errorCode: null };
    notify();
  }

  function setFailed(errorCode: string): void {
    view = { ...view, phase: 'failed', errorCode };
    notify();
  }

  function applyEdit(mutate: (current: CreateChannelView) => CreateChannelView): void {
    if (disposed) return;
    if (view.phase === 'failed' && view.roomId === null) {
      // A rejection before the channel exists means the input itself was refused;
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
   * A rejection or `unavailable` fails the step. A thrown rejection (not an `OperationResult`)
   * is treated the same as `unavailable`, so a step never leaves the UI stuck busy.
   */
  async function runStep<T>(step: PendingStep, run: () => Promise<OperationResult<T, string>>, onOk: (value: T) => void | Promise<void>): Promise<void> {
    pendingStep = step;
    try {
      const result = await run();
      if (disposed) return;
      if (result.kind === 'ok') await onOk(result.value);
      else if (result.kind === 'rejected') {
        setFailed(result.code);
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
      await attemptShare();
    });
  }

  async function attemptShare(): Promise<void> {
    // Hosted and private channels are ready after creation. Hosted sharing is
    // handled by the channel page's copy-link action.
    if (mode !== 'shared') {
      setPhase('ready');
      return;
    }
    setPhase('sharing');
    // Cleared unconditionally: a stale prior share URL must never survive into
    // a failed or resolving outcome, only a freshly confirmed `ok`.
    view = { ...view, shareUrl: null };
    const roomId = view.roomId as RoomId;
    shareOperationId ??= createId();
    frozenPolicy ??= selectedPolicy(view);
    await runStep('share', () => ports.admission.share({ operationId: shareOperationId!, roomId, policy: frozenPolicy! }), value => {
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

    setAdmissionPolicy(admissionPolicy) {
      applyEdit(current => ({ ...current, admissionPolicy, namedEmailError: null }));
    },

    setNamedEmail(namedEmail) {
      applyEdit(current => ({ ...current, namedEmail, namedEmailError: null }));
    },

    submit() {
      if (disposed || view.phase !== 'editing') return;
      const title = view.title.trim();
      const titleError = validateTitle(title, ports.limits);
      const namedEmail = view.namedEmail.trim();
      const namedEmailError = mode === 'shared' && view.admissionPolicy === 'named_no_history' && !EMAIL.test(namedEmail)
        ? 'email_invalid'
        : null;
      if (titleError !== null || namedEmailError !== null) {
        view = { ...view, title, titleError, namedEmail, namedEmailError };
        notify();
        return;
      }
      view = { ...view, title, titleError: null, namedEmail, namedEmailError: null };
      // Double submit is a no-op: phase leaves 'editing' before the first await,
      // and operationId is only ever assigned once per channel.
      operationId ??= createId();
      void attemptCreate();
    },

    retry() {
      if (disposed) return;
      if (view.phase !== 'failed' && view.phase !== 'resolving') return;
      view = { ...view, errorCode: null };
      if (pendingStep === 'create') void attemptCreate();
      else if (pendingStep === 'share') void attemptShare();
    },

    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}

/** @deprecated Use `createCreateChannelController`. Kept through the first tagged release containing #163. */
export const createChatController = createCreateChannelController;
