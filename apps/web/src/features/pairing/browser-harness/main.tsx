import { createRoot } from 'react-dom/client';
import { PAIRING_FIXTURE } from '../../approval-decision/pairing-fixture';
import type { DecisionChoice } from '../../approval-decision/model';
import type { PairingApprovalController } from '../controller';
import { INITIAL_PAIRING_VIEW, type PairingView } from '../model';
import { PairingApproval } from '../PairingApproval';

/**
 * Synthetic harness for the production PairingApproval panel: a scripted
 * controller, no network calls or credentials.
 */
declare global {
  interface Window {
    __pairingHarness: { decisions: DecisionChoice[] };
  }
}
window.__pairingHarness = { decisions: [] };

let view: PairingView = INITIAL_PAIRING_VIEW;
const listeners = new Set<(next: PairingView) => void>();
const publish = (next: PairingView) => {
  view = next;
  listeners.forEach(listener => listener(view));
};

const controller: PairingApprovalController = {
  getView: () => view,
  subscribe: listener => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  start: () => {},
  refresh: () => {},
  decide: choice => {
    window.__pairingHarness.decisions.push(choice);
    publish({
      ...view,
      pairing: { ...PAIRING_FIXTURE, state: choice === 'approve' ? 'approved' : 'denied' },
      status: { kind: 'decided', message: choice === 'approve' ? 'Pairing approved.' : 'Denied. Nothing was granted.' },
    });
  },
  retry: () => {},
  dispose: () => {},
};

// Load after first paint so the empty-then-filled status region is observable.
setTimeout(() => publish({ ...INITIAL_PAIRING_VIEW, phase: 'ready', pairing: PAIRING_FIXTURE }), 300);

createRoot(document.getElementById('root')!).render(
  <main style={{ padding: '1rem' }}>
    <PairingApproval controller={controller} />
    <button type="button">Unrelated control</button>
  </main>,
);
