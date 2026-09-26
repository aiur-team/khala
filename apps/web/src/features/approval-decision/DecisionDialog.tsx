import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { isDecidable, statusAnnouncement, type DecisionChoice, type DecisionFact, type DecisionPrompt, type DecisionStatus } from './model';

export interface DecisionDialogProps {
  /** Prefix for element ids; unique per mounted dialog. */
  id: string;
  prompt: DecisionPrompt;
  status: DecisionStatus;
  onDecide: (choice: DecisionChoice) => void;
  /** Resends the decision held by a `retryable` status. */
  onRetry: () => void;
  /** Closes without deciding. The request stays where the owner found it. */
  onDismiss: () => void;
  /**
   * Called on close when the element that opened the dialog is gone (for
   * example, the row moved after a decision), so focus never falls to the page.
   */
  restoreFocus?: () => void;
  /** Adapter-owned extra actions, such as mute. Rendered after the decision. */
  secondary?: ReactNode;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function Facts({ facts, untrusted = false }: { facts: readonly DecisionFact[]; untrusted?: boolean }) {
  return (
    <dl className="decision-dialog__facts">
      {facts.map(fact => (
        <div key={fact.label} className="decision-dialog__fact">
          <dt>{untrusted ? `${fact.label} (unverified)` : fact.label}</dt>
          <dd>
            {/* <bdi> keeps bidirectional text in a label from reordering what surrounds it. */}
            {fact.code ? <code>{fact.value}</code> : untrusted ? <bdi>{fact.value}</bdi> : fact.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The shared owner-decision dialog. Modal while open: focus moves in, Tab
 * cycles inside, Escape dismisses, and focus returns to whatever opened it.
 * It never opens itself; the host decides when it mounts.
 */
export function DecisionDialog({ id, prompt, status, onDecide, onRetry, onDismiss, restoreFocus, secondary }: DecisionDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef(restoreFocus);
  restoreRef.current = restoreFocus;

  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => {
      if (opener && opener.isConnected && opener !== document.body) opener.focus();
      else restoreRef.current?.();
    };
  }, []);

  useEffect(() => {
    // Disabling the focused button while submitting drops focus to the page;
    // keep it inside the dialog.
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) dialog.focus();
  }, [status.kind]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
      return;
    }
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  // Busy states keep the decision buttons in place but disabled.
  const submitting = status.kind === 'submitting' || status.kind === 'reloading';
  const open = isDecidable(status) || submitting;
  const announcement = status.kind === 'retryable' ? '' : statusAnnouncement(status, prompt);

  return (
    <div className="decision-dialog__backdrop">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-question`}
        aria-describedby={`${id}-kind`}
        aria-busy={submitting}
        tabIndex={-1}
        className="decision-dialog"
        onKeyDown={handleKeyDown}
      >
        <header className="decision-dialog__header">
          <div>
            <p id={`${id}-kind`} className="decision-dialog__kind">{prompt.kind}</p>
            <h2 id={`${id}-question`} className="decision-dialog__question">{prompt.question}</h2>
          </div>
          <button type="button" className="decision-dialog__close" onClick={onDismiss}>
            Close
          </button>
        </header>

        <div className="decision-dialog__body">
          <section aria-labelledby={`${id}-verified`}>
            <h3 id={`${id}-verified`}>Verified by Khala</h3>
            <Facts facts={prompt.verified} />
          </section>

          {prompt.untrusted.length > 0 ? (
            <section aria-labelledby={`${id}-untrusted`} className="decision-dialog__untrusted">
              <h3 id={`${id}-untrusted`}>Reported by the agent</h3>
              <p className="decision-dialog__hint">
                The agent chose these labels and they can say anything. Decide on the verified fingerprint above.
              </p>
              <Facts facts={prompt.untrusted} untrusted />
            </section>
          ) : null}

          <section aria-labelledby={`${id}-grants`}>
            <h3 id={`${id}-grants`}>If you approve</h3>
            <Facts facts={prompt.capabilities} />
            {prompt.notices.length > 0 ? (
              <ul className="decision-dialog__notices">
                {prompt.notices.map(notice => <li key={notice}>{notice}</li>)}
              </ul>
            ) : null}
          </section>

          <section aria-labelledby={`${id}-progress`}>
            <h3 id={`${id}-progress`}>Status</h3>
            <Facts facts={prompt.progress} />
          </section>
        </div>

        <footer className="decision-dialog__footer">
          <p role="status" aria-live="polite" className="decision-dialog__status">{announcement}</p>
          {status.kind === 'retryable' ? (
            <p role="alert" className="decision-dialog__alert">{status.message}</p>
          ) : null}
          <div className="decision-dialog__actions">
            {open ? (
              <>
                <button type="button" disabled={submitting} onClick={() => onDecide('deny')}>
                  {prompt.denyLabel}
                </button>
                <button type="button" className="decision-dialog__approve" disabled={submitting} onClick={() => onDecide('approve')}>
                  {prompt.approveLabel}
                </button>
              </>
            ) : null}
            {status.kind === 'retryable' ? (
              <button type="button" onClick={onRetry}>
                Retry: {status.decision === 'approve' ? prompt.approveLabel : prompt.denyLabel}
              </button>
            ) : null}
            {secondary}
          </div>
        </footer>
      </div>
    </div>
  );
}
