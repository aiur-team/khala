// Synthetic harness: the production ListeningControl and controller over an in-memory
// port shaped like the local server's owner routes. No server and no agent process.
import { createRoot } from 'react-dom/client';
import { ListeningControl } from '../ListeningControl';
import { createListeningController } from '../listening-controller';
import { provenCodexEntry, unprovenClaudeEntry } from '../listening-fixtures';
import { type ListeningPort, decodeBindingList } from '../listening-port';

type HarnessWindow = Window & { __calls: string[] };
const harness = window as unknown as HarnessWindow;
harness.__calls = [];

let ada = { requested: 'sync', version: 1, paused: false };
let beaPaused = false;
const list = () => decodeBindingList({
  v: 1, bindings: [provenCodexEntry(ada), unprovenClaudeEntry({ paused: beaPaused })],
})!;

const port: ListeningPort = {
  async list() { return { kind: 'listed', bindings: list() }; },
  async setMode(_channel, binding, requested) {
    harness.__calls.push(`mode:${binding.displayName}:${requested}:v${binding.version}`);
    ada = { ...ada, requested, version: ada.version + 1 };
    return { kind: 'done' };
  },
  async setPaused(_channel, binding, paused) {
    harness.__calls.push(`pause:${binding.displayName}:${paused}`);
    if (binding.bindingId === 'binding-ada') ada = { ...ada, paused };
    else beaPaused = paused;
    return { kind: 'done' };
  },
};

const controller = createListeningController(port, 'ch_harness');
void controller.refresh();
createRoot(document.querySelector('#root')!).render(<ListeningControl controller={controller} />);
