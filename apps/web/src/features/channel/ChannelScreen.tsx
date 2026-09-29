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
  onBack?: () => void;
  embedded?: boolean;
}

/** @deprecated Use `ChannelScreenProps`. Kept through the first tagged release containing #163. */
export type RoomScreenProps = ChannelScreenProps;

export function ChannelScreen({ title, description, theme = 'dark', controller, renderTimeline, renderReview, renderControls, renderShare, renderList, onBack, embedded = false }: ChannelScreenProps) {
  const [detailOpen, setDetailOpen] = useState(false);
  const content = (
      <KhalaPageFrame model={{ title, ...(description ? { description } : {}), labelledBy: 'khala-channel-title' }}>
        {renderList ? <ConversationLayout inThread list={renderList()} thread={<ChatThread title={title} onBack={onBack ?? (() => {})}>
          <div className="conversation-thread__actions"><span>{description}</span>{renderShare?.()}<button type="button" onClick={() => setDetailOpen(true)}>Details and controls</button></div>
          {renderTimeline()}
        </ChatThread>} detail={detailOpen ? <ParticipantDetail name={title} onClose={() => setDetailOpen(false)}>
          <AgentPresencePanel controller={controller} />{renderControls()}{renderReview()}
        </ParticipantDetail> : undefined} /> : <div className="channel-screen">
          <aside className="channel-screen__presence" aria-label="Channel agents">
            <AgentPresencePanel controller={controller} />
            {renderShare?.()}
            <div className="channel-screen__controls">{renderControls()}</div>
          </aside>
          <section className="channel-screen__conversation" aria-label="Channel conversation">
            {renderTimeline()}
          </section>
          <aside className="channel-screen__review" aria-label="Recipient review">
            {renderReview()}
          </aside>
        </div>}
      </KhalaPageFrame>
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
