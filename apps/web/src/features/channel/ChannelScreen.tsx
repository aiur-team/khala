import type { ReactNode } from 'react';
import { AiurShell } from '../../shell/AiurShell';
import { KhalaPageFrame } from '../../shell/KhalaPageFrame';
import type { ThemeChoice } from '../../shell/types';
import { AgentPresencePanel } from './AgentPresencePanel';
import type { ChannelController } from './controller';

export interface ChannelScreenProps {
  title: string;
  description?: string;
  theme?: ThemeChoice;
  controller: ChannelController;
  renderTimeline: () => ReactNode;
  renderReview: () => ReactNode;
  renderControls: () => ReactNode;
}

/** @deprecated Use `ChannelScreenProps`. Kept through the first tagged release containing #163. */
export type RoomScreenProps = ChannelScreenProps;

export function ChannelScreen({ title, description, theme = 'dark', controller, renderTimeline, renderReview, renderControls }: ChannelScreenProps) {
  return (
    <AiurShell
      mode="hosted-content"
      navigation={[]}
      theme={{ theme, onThemeChange: () => {} }}
      collapsed={false}
      onCollapsedChange={() => {}}
    >
      <KhalaPageFrame model={{ title, ...(description ? { description } : {}), labelledBy: 'khala-channel-title' }}>
        <div className="channel-screen">
          <aside className="channel-screen__presence" aria-label="Channel agents">
            <AgentPresencePanel controller={controller} />
            <div className="channel-screen__controls">{renderControls()}</div>
          </aside>
          <section className="channel-screen__conversation" aria-label="Channel conversation">
            {renderTimeline()}
          </section>
          <aside className="channel-screen__review" aria-label="Recipient review">
            {renderReview()}
          </aside>
        </div>
      </KhalaPageFrame>
    </AiurShell>
  );
}

/** @deprecated Use `ChannelScreen`. Kept through the first tagged release containing #163. */
export const RoomScreen = ChannelScreen;
