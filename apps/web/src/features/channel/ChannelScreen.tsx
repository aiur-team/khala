import type { ReactNode } from 'react';
import { AiurShell } from '../../shell/AiurShell';
import { KhalaPageFrame } from '../../shell/KhalaPageFrame';
import type { ThemeChoice } from '../../shell/types';
import type { ChannelController } from './controller';
import { ChatThread, ConversationLayout } from '../../ui/conversation';

export interface ChannelScreenProps {
  title: string;
  description?: string;
  theme?: ThemeChoice;
  controller: ChannelController;
  renderTimeline: () => ReactNode;
  renderShare?: () => ReactNode;
  renderHeaderActions?: () => ReactNode;
  showPresence?: boolean;
  onBack?: () => void;
  embedded?: boolean;
}

/** @deprecated Use `ChannelScreenProps`. Kept through the first tagged release containing #163. */
export type RoomScreenProps = ChannelScreenProps;

export function ChannelScreen({ title, description, theme = 'dark', renderTimeline, renderShare, renderHeaderActions, onBack, embedded = false }: ChannelScreenProps) {
  const content = (
    <div className="channel-page"><KhalaPageFrame model={{ title, labelledBy: 'khala-channel-title' }}>
        <ConversationLayout inThread thread={<ChatThread title={title} {...(onBack ? { onBack } : {})}>
          {description || renderHeaderActions || renderShare ? <div className="conversation-thread__actions">{description ? <span>{description}</span> : null}{renderHeaderActions?.()}{renderShare?.()}</div> : null}
          {renderTimeline()}
        </ChatThread>} />
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
