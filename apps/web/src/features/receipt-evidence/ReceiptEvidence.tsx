// Presentation of receipt evidence as a set of independent facts. A token return
// always carries its boundary as a programmatic description and a keyboard help
// control; "no token-return fact" appears only when a ready read confirmed it.

import { useId, useState, type Ref } from 'react';
import type { DeliveryReceiptTransport } from '@khala/contracts/delivery/index';
import type { ReceiptEvidenceStatus } from './controller';
import type { EvidenceUnit } from './model';
import { EVIDENCE_UNAVAILABLE, NO_TOKEN_RETURN, TOKEN_RETURN_HELP, receiptEvidenceLabel } from './vocabulary';

function TokenReturnFact({ receipt }: { receipt: DeliveryReceiptTransport }) {
  const helpId = useId();
  const [open, setOpen] = useState(false);
  return (
    <li className="receipt-evidence__fact receipt-evidence__fact--token-return" aria-describedby={helpId}>
      <span>{receiptEvidenceLabel(receipt)}</span>
      {' '}
      <button
        type="button"
        className="receipt-evidence__help"
        aria-expanded={open}
        aria-controls={helpId}
        onClick={() => setOpen(value => !value)}
      >
        What this means
      </button>
      <span id={helpId} className="receipt-evidence__help-text" hidden={!open}>{TOKEN_RETURN_HELP}</span>
    </li>
  );
}

function Facts({ receipts }: { receipts: readonly DeliveryReceiptTransport[] }) {
  return (
    <>
      {receipts.map(receipt => (
        <li key={receipt.receiptId} className="receipt-evidence__fact">
          {receiptEvidenceLabel(receipt)}
        </li>
      ))}
    </>
  );
}

/** The token-return status once, or a confirmed absence only after a ready read. */
function TokenReturn({ unit, confirmAbsence }: { unit: EvidenceUnit; confirmAbsence: boolean }) {
  if (unit.tokenReturn) return <TokenReturnFact receipt={unit.tokenReturn} />;
  return confirmAbsence ? <li className="receipt-evidence__fact receipt-evidence__fact--absent">{NO_TOKEN_RETURN}</li> : null;
}

/** One release carrying one message: its facts sit beside that message. */
export function InlineEvidence({ unit, status }: { unit: EvidenceUnit; status: ReceiptEvidenceStatus }) {
  return (
    <ul className="receipt-evidence receipt-evidence--inline" aria-label="Delivery evidence">
      <TokenReturn unit={unit} confirmAbsence={status === 'ready'} />
      <Facts receipts={unit.releases[0]?.receipts ?? []} />
    </ul>
  );
}

/**
 * Every fact of one unit as a flat list: the batch token return once, then each
 * release's own facts. `confirmAbsence` is true only for a source that proves it
 * reports token returns completely.
 */
export function UnitFacts({ unit, confirmAbsence }: { unit: EvidenceUnit; confirmAbsence: boolean }) {
  return (
    <ul className="receipt-evidence" aria-label="Delivery evidence">
      <TokenReturn unit={unit} confirmAbsence={confirmAbsence} />
      {unit.releases.map(release => <Facts key={release.releaseId} receipts={release.receipts} />)}
    </ul>
  );
}

function groupHeading(unit: EvidenceUnit): string {
  const messages = `${unit.eventIds.length} message${unit.eventIds.length === 1 ? '' : 's'}`;
  return unit.kind === 'batch'
    ? `Batch evidence: ${unit.releases.length} releases, ${messages}`
    : `Release evidence: ${messages}`;
}

/** A batch or multi-message release: one group with a stable target and a focusable heading. */
export function EvidenceGroup({ unit, status, headingRef }: {
  unit: EvidenceUnit;
  status: ReceiptEvidenceStatus;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  const headingId = `${unit.id}-heading`;
  return (
    <section id={unit.id} className="receipt-evidence receipt-evidence--group" aria-labelledby={headingId}>
      <h3 id={headingId} ref={headingRef} tabIndex={-1}>{groupHeading(unit)}</h3>
      <ul className="receipt-evidence__batch" aria-label="Batch observations">
        <TokenReturn unit={unit} confirmAbsence={status === 'ready'} />
      </ul>
      <ol className="receipt-evidence__releases" aria-label="Releases">
        {unit.releases.map((release, index) => (
          <li key={release.releaseId}>
            <span className="receipt-evidence__release-label">Release {index + 1}</span>
            <ul className="receipt-evidence__facts">
              <Facts receipts={release.receipts} />
            </ul>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * Evidence access, kept apart from the messages it annotates: loading says so,
 * and a partial or failed read offers retry without claiming anything is absent.
 */
export function EvidenceAccess({ status, onRetry }: { status: ReceiptEvidenceStatus; onRetry: () => void }) {
  if (status === 'loading') return <p className="receipt-evidence__access">Loading delivery evidence…</p>;
  if (status === 'ready') return null;
  return (
    <p className="receipt-evidence__access">
      {EVIDENCE_UNAVAILABLE}
      {status === 'partial' ? ' for some messages' : ''}.
      {' '}
      <button type="button" onClick={onRetry}>Retry</button>
    </p>
  );
}

/** Polite, focus-neutral announcement of facts observed after hydration. */
export function EvidenceAnnouncer({ text }: { text: string | null }) {
  return <p className="receipt-evidence__announcer" role="status" aria-live="polite">{text ?? ''}</p>;
}
