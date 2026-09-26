import { useEffect, useRef, useState } from 'react';import { Panel } from '../../shell/Panel';
import { DecisionDialog } from '../approval-decision/DecisionDialog';
import { isDecidable } from '../approval-decision/model';
import type { PairingApprovalController } from './controller';
import { pairingStateLabel, toDecisionPrompt, type PairingView } from './model';

/** Subscribes a component to a pairing controller. */
export function usePairingView(controller: PairingApprovalController): PairingView {
  const [view, setView] = useState<PairingView>(() => controller.getView());
  useEffect(() => {
    setView(controller.getView());
    return controller.subscribe(setView);
  }, [controller]);
  return view;
}

export interface PairingApprovalProps {
  /** Bound to one request handle; the host starts and disposes it. */
  controller: PairingApprovalController;
}

function summary(view: PairingView): string {
  if (view.phase === 'loading') return 'Loading pairing request…';
  if (view.phase === 'load_failed') return 'Could not load this pairing request.';
  if (view.status.kind === 'blocked' || view.status.kind === 'decided' || view.status.kind === 'refreshed') return view.status.message;
  return '';
}

/**
 * One pairing claim, shown through the shared decision dialog. The page never
 * opens the dialog itself: the owner asks to review, so focus only moves when
 * they choose.
 */
export function PairingApproval({ controller }: PairingApprovalProps) {
  const view = usePairingView(controller);
  const [open, setOpen] = useState(false);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const pairing = view.pairing;
  const prompt = pairing ? toDecisionPrompt(pairing) : null;
  const message = summary(view);
  const canReview = pairing !== null && (isDecidable(view.status) || view.status.kind === 'submitting' || view.status.kind === 'reloading' || view.status.kind === 'retryable');

  return (
    <Panel
      heading="Pairing request"
      status={view.phase === 'loading' ? 'busy' : view.phase === 'load_failed' ? 'error' : 'idle'}
      statusMessage={message}
    >
      <div className="pairing">
        <h3 ref={headingRef} tabIndex={-1} className="pairing__heading">
          {pairing?.claim ? `${pairing.claim.harness} session ${pairing.claim.fingerprint}` : 'No agent session yet'}
        </h3>
        {pairing ? (
          <dl className="pairing__state">
            <dt>Your decision</dt>
            <dd>{pairingStateLabel(pairing)}</dd>
          </dl>
        ) : null}
        <p role="status" aria-live="polite" className="pairing__status">{message}</p>
        {/* Never disabled: the dialog returns focus here when it closes. */}
        <button type="button" onClick={() => setOpen(true)}>
          {canReview ? 'Review pairing' : 'View details'}
        </button>
      </div>
      {open && prompt ? (
        <DecisionDialog
          id="pairing-approval"
          prompt={prompt}
          status={view.status}
          onDecide={choice => controller.decide(choice)}
          onRetry={() => controller.retry()}
          onDismiss={() => setOpen(false)}
          restoreFocus={() => headingRef.current?.focus()}
        />
      ) : null}
    </Panel>
  );
}
