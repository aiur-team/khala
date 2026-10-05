import { createRoot } from 'react-dom/client';
import { AiurShell } from '../../../shell/AiurShell';
import { KhalaPageFrame } from '../../../shell/KhalaPageFrame';
import type { NavigationItem } from '../../../shell/types';
import { TimelineScreen } from '../TimelineScreen';
import { createTimelineController } from '../controller';
import { createFakeChannelPort } from './fake-channel-port';

const navigation: NavigationItem[] = [{ id: 'timeline', label: 'Conversation', href: '#timeline', current: true }];

const params = new URLSearchParams(location.search);
const harness = createFakeChannelPort(params.has('empty'));
// Sparse raw pages exercise viewport filling; cached mode uses real name scanning.
const baseController = createTimelineController(harness.port, harness.roomId, { generation: 1, pageSize: params.has('sparse') ? 1 : 20 });
const controller = params.has('cached') ? baseController : { ...baseController, scanNameHistory: async () => {} };

declare global {
  interface Window {
    __timelineHarness: {
      historyCalls: () => number;
      delayHistory: () => void;
      releaseHistory: () => void;
      showUnavailable: () => void;
      decryptUnavailable: () => void;
      pushLiveMessage: (body: string) => void;
      releaseNextSend: () => void;
      delayNextSend: () => void;
      releaseDelayedSend: () => void;
      bumpGeneration: () => void;
      revokeMembership: () => void;
    };
  }
}
window.__timelineHarness = {
  historyCalls: harness.historyCalls,
  delayHistory: harness.delayHistory,
  releaseHistory: harness.releaseHistory,
  showUnavailable: harness.showUnavailable,
  decryptUnavailable: harness.decryptUnavailable,
  pushLiveMessage: harness.pushLiveMessage,
  releaseNextSend: harness.releaseNextSend,
  delayNextSend: harness.delayNextSend,
  releaseDelayedSend: harness.releaseDelayedSend,
  bumpGeneration: harness.bumpGeneration,
  revokeMembership: harness.revokeMembership,
};

function Harness() {
  return (
    <AiurShell mode="standalone" navigation={navigation} theme={{ theme: new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark', onThemeChange: () => {} }} collapsed={false} onCollapsedChange={() => {}}>
      <KhalaPageFrame model={{ title: 'Conversation', labelledBy: 'timeline-heading' }}>
        <TimelineScreen
          controller={controller}
          roomPort={harness.port}
          roomId={harness.roomId}
          viewer={harness.viewer}
          renderReviewAction={ref => <button data-testid={`review-${ref.eventId}`}>Review {ref.eventId}</button>}
        />
      </KhalaPageFrame>
    </AiurShell>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
