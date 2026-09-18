import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Panel } from '../../shell/Panel';
import { createChatController, type CreateChatController } from './controller';
import type { CreateChatView } from './model';
import type { CreateChatPorts } from './ports';
import { copyShareLink, type CopyResult } from './share-link';

export interface CreateChatScreenProps {
  ports: CreateChatPorts;
  /** Injected for tests and for hosts that supply their own clipboard bridge. */
  onCopyShareLink?: (shareUrl: string) => Promise<CopyResult>;
  /** Test-only seam: a pre-built controller (for example one already driven to a target phase). */
  controller?: CreateChatController;
}

type Readiness = Readonly<{ kind: 'checking' } | { kind: 'blocked'; reason: string } | { kind: 'ready' }>;

const RESOLVING_MESSAGE = 'Resuming the last step. This can take a moment.';
const BUSY_MESSAGE: Partial<Record<CreateChatView['phase'], string>> = {
  creating: 'Creating the chat…',
  preparing_intro: 'Sending your introduction messages…',
  sharing: 'Preparing the share link…',
  resolving: RESOLVING_MESSAGE,
};

export function CreateChatScreen({ ports, onCopyShareLink = copyShareLink, controller: injectedController }: CreateChatScreenProps) {
  const ownController = useMemo(() => createChatController(ports), [ports]);
  const controller = injectedController ?? ownController;
  const [view, setView] = useState<CreateChatView>(() => controller.getView());
  const [readiness, setReadiness] = useState<Readiness>({ kind: 'checking' });
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'denied'>('idle');
  const removeButtonRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const [focusAfterRemoveIndex, setFocusAfterRemoveIndex] = useState<number | null>(null);

  useEffect(() => {
    // Sync immediately: a controller swap (new `ports`, e.g. a sign-out or
    // account change) must not leave the previous controller's stale view —
    // including a completed share link — rendered until it next emits.
    setView(controller.getView());
    return controller.subscribe(setView);
  }, [controller]);
  useEffect(() => () => controller.dispose(), [controller]);

  useEffect(() => {
    let cancelled = false;
    async function checkReadiness() {
      try {
        const identity = await ports.identity.current();
        if (cancelled) return;
        if (identity.kind === 'signed_out') {
          setReadiness({ kind: 'blocked', reason: 'Sign in to create a chat.' });
          return;
        }
        if (identity.kind === 'unavailable') {
          setReadiness({ kind: 'blocked', reason: 'Account status is unavailable right now. Try again shortly.' });
          return;
        }
        const device = await ports.device.ensureReady(identity.principal.ownerId);
        if (cancelled) return;
        if (device.kind !== 'ok' || device.value.state !== 'ready') {
          setReadiness({ kind: 'blocked', reason: 'This device is not ready yet.' });
          return;
        }
        setReadiness({ kind: 'ready' });
      } catch {
        if (!cancelled) setReadiness({ kind: 'blocked', reason: 'Account status is unavailable right now. Try again shortly.' });
      }
    }
    void checkReadiness();
    return () => {
      cancelled = true;
    };
  }, [ports]);

  useEffect(() => {
    if (focusAfterRemoveIndex === null) return;
    const target = view.intros[Math.min(focusAfterRemoveIndex, view.intros.length - 1)];
    if (target) removeButtonRefs.current.get(target.localId)?.focus();
    else addButtonRef.current?.focus();
    setFocusAfterRemoveIndex(null);
  }, [focusAfterRemoveIndex, view.intros]);

  useEffect(() => {
    setCopyStatus('idle');
  }, [view.shareUrl]);

  const editable = view.phase === 'editing';
  const retryable = view.phase === 'failed' || view.phase === 'resolving';
  const canSubmit = editable && readiness.kind === 'ready';
  const busyMessage = BUSY_MESSAGE[view.phase];

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    controller.submit();
  }

  function handleRemove(localId: string, index: number) {
    controller.removeIntro(localId);
    setFocusAfterRemoveIndex(index);
  }

  async function handleCopy() {
    if (!view.shareUrl) return;
    const result = await onCopyShareLink(view.shareUrl);
    setCopyStatus(result.ok ? 'copied' : 'denied');
  }

  return (
    <Panel heading="Create a chat">
      <form onSubmit={handleSubmit}>
        <div className="create-chat__field">
          <label htmlFor="create-chat-title">Chat name (optional)</label>
          <input
            id="create-chat-title"
            type="text"
            value={view.title}
            disabled={!editable}
            onChange={event => controller.setTitle(event.target.value)}
          />
        </div>

        <fieldset className="create-chat__intros">
          <legend>Introduction messages</legend>
          <ol className="create-chat__intro-list">
            {view.intros.map((intro, index) => (
              <li key={intro.localId} className="create-chat__intro-item">
                <label htmlFor={`create-chat-intro-${intro.localId}`}>Message {index + 1}</label>
                <textarea
                  id={`create-chat-intro-${intro.localId}`}
                  value={intro.body}
                  disabled={!editable}
                  onChange={event => controller.updateIntro(intro.localId, event.target.value)}
                />
                <div className="create-chat__intro-actions">
                  <button
                    type="button"
                    disabled={!editable || index === 0}
                    onClick={() => controller.reorderIntro(intro.localId, 'up')}
                  >
                    Move message {index + 1} up
                  </button>
                  <button
                    type="button"
                    disabled={!editable || index === view.intros.length - 1}
                    onClick={() => controller.reorderIntro(intro.localId, 'down')}
                  >
                    Move message {index + 1} down
                  </button>
                  <button
                    type="button"
                    ref={node => {
                      removeButtonRefs.current.set(intro.localId, node);
                    }}
                    disabled={!editable}
                    onClick={() => handleRemove(intro.localId, index)}
                  >
                    Remove message {index + 1}
                  </button>
                </div>
              </li>
            ))}
          </ol>
          <button type="button" ref={addButtonRef} disabled={!editable} onClick={() => controller.addIntro()}>
            Add introduction message
          </button>
        </fieldset>

        {readiness.kind === 'blocked' ? <p role="alert">{readiness.reason}</p> : null}
        <button type="submit" disabled={!canSubmit}>
          Create chat
        </button>
      </form>

      <p aria-live="polite" className="create-chat__status">
        {busyMessage ?? ''}
      </p>

      {view.errorCode ? (
        <p role="alert">
          Could not finish creating the chat ({view.errorCode}).{' '}
          {retryable ? (
            <button type="button" onClick={() => controller.retry()}>
              Retry
            </button>
          ) : null}
        </p>
      ) : null}
      {!view.errorCode && view.phase === 'resolving' ? (
        <button type="button" onClick={() => controller.retry()}>
          Retry
        </button>
      ) : null}

      {view.phase === 'ready' && view.shareUrl ? (
        <div className="create-chat__share">
          <label htmlFor="create-chat-share-url">Chat link</label>
          <input
            id="create-chat-share-url"
            className="create-chat__share-url"
            readOnly
            value={view.shareUrl}
            onFocus={event => event.currentTarget.select()}
          />
          <button type="button" onClick={handleCopy}>
            Copy link
          </button>
          <p role="status">
            {copyStatus === 'copied' ? 'Link copied.' : copyStatus === 'denied' ? 'Copy failed — select and copy the link above.' : ''}
          </p>
        </div>
      ) : null}
    </Panel>
  );
}
