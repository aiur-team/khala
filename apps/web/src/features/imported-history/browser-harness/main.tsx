import { createRoot } from 'react-dom/client';
import { ImportedHistorySection } from '../ImportedTranscript';
import type { ImportedHistoryRead } from '../model';
import type { ImportedHistoryPort } from '../ports';

// Renders the production section over a port that returns the verified archive the
// browser spec produced with a real conversion and injected before load.

declare global {
  interface Window {
    __importedRead?: ImportedHistoryRead;
    __importedHarness?: { rendered: boolean };
  }
}

const port: ImportedHistoryPort = { open: async () => window.__importedRead ?? { kind: 'none' } };
window.__importedHarness = { rendered: false };
createRoot(document.querySelector('#app')!).render(<ImportedHistorySection port={port} channelId="external-1" importerLabel="Ada" />);
setTimeout(() => {
  window.__importedHarness!.rendered = true;
}, 300);
