import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DecisionDialog } from '../DecisionDialog';
import type { DecisionChoice, DecisionStatus } from '../model';
import { PAIRING_FIXTURE, pairingFixturePrompt } from '../pairing-fixture';

/**
 * Synthetic pairing fixture for the browser harness only: the shared shell
 * with the pairing adapter, and no network calls or credentials.
 */
declare global {
  interface Window {
    __decisionHarness: { decisions: DecisionChoice[] };
  }
}
window.__decisionHarness = { decisions: [] };

function Harness() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<DecisionStatus>({ kind: 'idle' });
  return (
    <main style={{ padding: '1rem' }}>
      <button type="button" onClick={() => setOpen(true)}>
        Review pairing
      </button>
      <button type="button">Unrelated control</button>
      {open ? (
        <DecisionDialog
          id="pairing"
          prompt={pairingFixturePrompt(PAIRING_FIXTURE)}
          status={status}
          onDecide={choice => {
            window.__decisionHarness.decisions.push(choice);
            setStatus({ kind: 'decided', message: choice === 'approve' ? 'Pairing approved.' : 'Pairing denied.' });
          }}
          onRetry={() => {}}
          onDismiss={() => {
            setOpen(false);
            setStatus({ kind: 'idle' });
          }}
        />
      ) : null}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
