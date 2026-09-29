import { useState, type ReactNode } from 'react';
import { AiurShell } from '../../shell/AiurShell';
import { KhalaPageFrame } from '../../shell/KhalaPageFrame';
import type { ThemeChoice } from '../../shell/types';
import { AgentPresencePanel } from './AgentPresencePanel';
import type { ChannelController } from './controller';
import { ChatThread, ConversationLayout, ParticipantDetail } from '../../ui/conversation';

export interface ChannelScreenProps {
  title: string;
  description?: string;
  theme?: ThemeChoice;
  controller: ChannelController;
  renderTimeline: () => ReactNode;
  renderReview: () => ReactNode;
  renderControls: () => ReactNode;
  renderShare?: () => ReactNode;
  renderList?: () => ReactNode;
  renderHeaderActions?: () => ReactNode;
  showPresence?: boolean;
  onBack?: () => void;
  embedded?: boolean;
}

/** @deprecated Use `ChannelScreenProps`. Kept through the first tagged release containing #163. */
export type RoomScreenProps = ChannelScreenProps;

export function ChannelScreen({ title, description, theme = 'dark', controller, renderTimeline, renderReview, renderControls, renderShare, renderHeaderActions, showPresence = true, onBack, embedded = false }: ChannelScreenProps) {
  const [detailOpen, setDetailOpen] = useState(false);
  const content = (
    <div className="channel-page"><KhalaPageFrame model={{ title, labelledBy: 'khala-channel-title' }}>
        <ConversationLayout inThread thread={<ChatThread title={title} {...(onBack ? { onBack } : {})}>
          <div className="conversation-thread__actions">{description ? <span>{description}</span> : null}{renderHeaderActions?.()}{renderShare?.()}<button type="button" className="aiur-shell__icon-button" aria-label="Channel settings" title="Channel settings" onClick={() => setDetailOpen(true)}>
            <svg aria-hidden="true" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
          </button></div>
          {renderTimeline()}
        </ChatThread>} detail={detailOpen ? <ParticipantDetail name={title} onClose={() => setDetailOpen(false)}>
          {showPresence ? <AgentPresencePanel controller={controller} /> : null}{renderControls()}{renderReview()}
        </ParticipantDetail> : undefined} />
      </KhalaPageFrame></div>
  );
  return embedded ? content : (
    <AiurShell
      mode="hosted-content"
      navigation={[]}
      theme={{ theme, onThemeChange: () => {} }}
      collapsed={false}
      onCollapsedChange={() => {}}
    >
      {content}
    </AiurShell>
  );
}

/** @deprecated Use `ChannelScreen`. Kept through the first tagged release containing #163. */
export const RoomScreen = ChannelScreen;
