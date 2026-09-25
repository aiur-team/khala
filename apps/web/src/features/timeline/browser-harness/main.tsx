import { createRoot } from 'react-dom/client';
import { AiurShell } from '../../../shell/AiurShell';
import { KhalaPageFrame } from '../../../shell/KhalaPageFrame';
import type { NavigationItem } from '../../../shell/types';
import { TimelineScreen } from '../TimelineScreen';
import { createTimelineController } from '../controller';
import { createFakeChannelPort } from './fake-channel-port';

const navigation: NavigationItem[] = [{ id: 'timeline', label: 'Conversation', href: '#timeline', current: true }];

const harness = createFakeChannelPort();
const controller = createTimelineController(harness.port, harness.roomId, { generation: 1, pageSize: 20 });

declare global {
  interface Window {
    __timelineHarness: {
      pushLiveMessage: (body: string) => void;
      bumpGeneration: () => void;
      revokeMembership: () => void;
    };
  }
}
window.__timelineHarness = {
  pushLiveMessage: harness.pushLiveMessage,
  bumpGeneration: harness.bumpGeneration,
  revokeMembership: harness.revokeMembership,
};

function Harness() {
  return (
    <AiurShell mode="standalone" navigation={navigation} theme={{ theme: 'dark', onThemeChange: () => {} }} collapsed={false} onCollapsedChange={() => {}}>
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
