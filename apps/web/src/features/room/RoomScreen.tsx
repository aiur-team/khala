import type { ReactNode } from 'react';
import { AiurShell } from '../../shell/AiurShell';
import { KhalaPageFrame } from '../../shell/KhalaPageFrame';
import type { ThemeChoice } from '../../shell/types';
import { AgentPresencePanel } from './AgentPresencePanel';
import type { RoomController } from './controller';

export interface RoomScreenProps {
  title: string;
  description?: string;
  theme?: ThemeChoice;
  controller: RoomController;
  renderTimeline: () => ReactNode;
  renderReview: () => ReactNode;
  renderControls: () => ReactNode;
}

export function RoomScreen({ title, description, theme = 'dark', controller, renderTimeline, renderReview, renderControls }: RoomScreenProps) {
  return (
    <AiurShell
      mode="hosted-content"
      navigation={[]}
      theme={{ theme, onThemeChange: () => {} }}
      collapsed={false}
      onCollapsedChange={() => {}}
    >
      <KhalaPageFrame model={{ title, ...(description ? { description } : {}), labelledBy: 'khala-room-title' }}>
        <div className="room-screen">
          <aside className="room-screen__presence" aria-label="Room agents">
            <AgentPresencePanel controller={controller} />
            <div className="room-screen__controls">{renderControls()}</div>
          </aside>
          <section className="room-screen__conversation" aria-label="Room conversation">
            {renderTimeline()}
          </section>
          <aside className="room-screen__review" aria-label="Recipient review">
            {renderReview()}
          </aside>
        </div>
      </KhalaPageFrame>
    </AiurShell>
  );
}
