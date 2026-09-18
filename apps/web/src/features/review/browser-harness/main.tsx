import { createRoot } from 'react-dom/client';
import type { ApprovalCommand } from '@khala/contracts/delivery/index';
import { AiurShell } from '../../../shell/AiurShell';
import { KhalaPageFrame } from '../../../shell/KhalaPageFrame';
import type { NavigationItem } from '../../../shell/types';
import { ReviewScreen } from '../ReviewScreen';
import { createReviewController } from '../controller';
import { createFakeReviewPort } from './fake-review-port';

const navigation: NavigationItem[] = [{ id: 'review', label: 'Review', href: '#review', current: true }];

const harness = createFakeReviewPort();
const controller = createReviewController(harness.port);

declare global {
  interface Window {
    __reviewHarness: {
      pushLiveArrival: (body: string) => void;
      pushOutcomeUnknownTarget: () => void;
      editPending: (eventId: string, body: string) => void;
      bumpBindingGeneration: () => void;
      revoke: () => void;
      getLastCommand: () => ApprovalCommand | null;
    };
  }
}
window.__reviewHarness = {
  pushLiveArrival: harness.pushLiveArrival,
  pushOutcomeUnknownTarget: harness.pushOutcomeUnknownTarget,
  editPending: harness.editPending,
  bumpBindingGeneration: harness.bumpBindingGeneration,
  revoke: harness.revoke,
  getLastCommand: harness.getLastCommand,
};

// A plain-text render function stands in for the real inert renderer
// (composition wires timeline's `renderMessageContent` in production, KHA-134)
// — this harness proves the review feature's own render-slot isolation, not
// the renderer's own sanitization, which timeline's own tests already prove.
function renderContent(content: { kind: string; body?: string }): string {
  return content.kind === 'text' ? (content.body ?? '') : 'Unsupported content.';
}

function Harness() {
  return (
    <AiurShell mode="standalone" navigation={navigation} theme={{ theme: 'dark', onThemeChange: () => {} }} collapsed={false} onCollapsedChange={() => {}}>
      <KhalaPageFrame model={{ title: 'Review', labelledBy: 'review-heading' }}>
        <ReviewScreen controller={controller} recipientLabel="Release Agent" renderContent={renderContent} />
      </KhalaPageFrame>
    </AiurShell>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
