import { AgentPresencePanel } from './AgentPresencePanel';
import { useSyncExternalStore, type ReactNode } from 'react';
import { AiurShell } from '../../shell/AiurShell';
import { KhalaPageFrame } from '../../shell/KhalaPageFrame';
import type { ThemeChoice } from '../../shell/types';
import type { ChannelController } from './controller';
import { ChatThread, ConversationLayout } from '../../ui/conversation';
import type { OwnerId, ParticipantId } from '@khala/contracts/messaging/ids';

export interface ChannelScreenProps {
  title: string;
  description?: string;
  theme?: ThemeChoice;
  controller: ChannelController;
  viewerOwnerId?: OwnerId;
  viewerName?: string;
  currentNames?: ReadonlyMap<ParticipantId, string>;
  namesPending?: boolean;
  renameAgent?: (participantId: ParticipantId, name: string, clientTxnId: string) => Promise<'accepted' | 'unknown' | 'rejected'>;
  renameScope?: string;
  renderTimeline: () => ReactNode;
  renderShare?: () => ReactNode;
  renderHeaderActions?: () => ReactNode;
  showPresence?: boolean;
  onBack?: () => void;
  embedded?: boolean;
}

/** @deprecated Use `ChannelScreenProps`. Kept through the first tagged release containing #163. */
export type RoomScreenProps = ChannelScreenProps;

function ChannelParticipants({ controller, currentNames, namesPending, description, viewerName }: Pick<ChannelScreenProps, 'controller' | 'currentNames' | 'namesPending' | 'description' | 'viewerName'>) {
  const { agents } = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  return <div className="channel-participants" aria-label="Channel participants">
    {description ? <span className="channel-participants__context">{description}</span> : null}
    {viewerName ? <span className="channel-participants__chip" title={`${viewerName} · human`}><span className="channel-participants__avatar channel-participants__avatar--human" aria-hidden="true">{viewerName.trim().slice(0, 1).toLocaleUpperCase()}</span><span className="channel-participants__name">{viewerName}</span></span> : null}
    {agents.slice(0, 4).map(agent => {
      const name = namesPending ? 'Agent name unavailable' : currentNames?.get(agent.participantId) ?? agent.displayName;
      return <span key={agent.participantId} className="channel-participants__chip" title={`${name} · ${agent.connection}`}>
        <span className="channel-participants__avatar" aria-hidden="true">{name.trim().slice(0, 1).toLocaleUpperCase()}</span><span className="channel-participants__name">{name}</span>
      </span>;
    })}
    {agents.length > 4 ? <span className="channel-participants__more">+{agents.length - 4}</span> : null}
  </div>;
}

export function ChannelScreen({ title, description, theme = 'dark', controller, viewerOwnerId, viewerName, currentNames, namesPending, renameAgent, renameScope,
  renderTimeline, renderShare, renderHeaderActions, onBack, embedded = false }: ChannelScreenProps) {
  const content = (
    <div className="channel-page"><KhalaPageFrame model={{ title, labelledBy: 'khala-channel-title' }}>
        <ConversationLayout inThread thread={<ChatThread title={title} {...(onBack ? { onBack } : {})}
          headerDetail={<ChannelParticipants controller={controller} {...(currentNames ? { currentNames } : {})} {...(namesPending !== undefined ? { namesPending } : {})} {...(description ? { description } : {})} {...(viewerName ? { viewerName } : {})} />}
          headerActions={<>{renameAgent ? <details className="channel-agent-names"><summary className="aiur-shell__icon-button" aria-label="Agent names and controls" title="Agent names and controls">◉</summary><div className="channel-agent-names__panel"><AgentPresencePanel controller={controller} {...(viewerOwnerId ? { viewerOwnerId } : {})} {...(currentNames ? { currentNames } : {})} {...(namesPending !== undefined ? { namesPending } : {})} {...(renameScope ? { renameScope } : {})} renameAgent={renameAgent} /></div></details> : null}{renderHeaderActions?.()}{renderShare?.()}</>}>
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
