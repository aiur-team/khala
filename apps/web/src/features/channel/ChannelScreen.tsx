import { useState, type ReactNode } from 'react';
import { AiurShell } from '../../shell/AiurShell';
import { SettingsIcon } from '../../shell/icons';
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
            <SettingsIcon />
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
