// Synthetic harness: the production StopControl and controller over a fake port
// whose replies the spec releases one at a time. No server and no agent process.
import { createRoot } from 'react-dom/client';
import { StopControl } from '../StopControl';
import { createStopController } from '../stop-controller';
import type { StopOutcome } from '../stop-port';

type HarnessWindow = Window & { __stopCalls: number; __releaseStop: (outcome: StopOutcome) => void };
const harness = window as unknown as HarnessWindow;
harness.__stopCalls = 0;
const waiting: ((outcome: StopOutcome) => void)[] = [];
harness.__releaseStop = outcome => waiting.shift()?.(outcome);

const controller = createStopController({
  stop: () => {
    harness.__stopCalls += 1;
    return new Promise<StopOutcome>(resolve => { waiting.push(resolve); });
  },
}, 'ch_harness');

createRoot(document.querySelector('#root')!).render(
  <StopControl controller={controller} replacementAccessUrl="http://127.0.0.1:4871/channels/ch_harness" />,
);
