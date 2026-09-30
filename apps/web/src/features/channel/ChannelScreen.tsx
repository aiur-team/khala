import { AgentPresencePanel } from './AgentPresencePanel';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AiurShell } from '../../shell/AiurShell';
import { KhalaPageFrame } from '../../shell/KhalaPageFrame';
import type { ThemeChoice } from '../../shell/types';
import type { ChannelController } from './controller';
import { ChatThread, ConversationLayout } from '../../ui/conversation';
import type { OwnerId, ParticipantId } from '@khala/contracts/messaging/ids';
import { participantRosterName } from './participant-name';

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
    {viewerName ? <span className="channel-participants__chip" title={`${participantRosterName(viewerName, 'You')} · human`}><span className="channel-participants__avatar channel-participants__avatar--human" aria-hidden="true">{participantRosterName(viewerName, 'You').trim().slice(0, 1).toLocaleUpperCase()}</span><span className="channel-participants__name">{participantRosterName(viewerName, 'You')}</span></span> : null}
    {agents.slice(0, 4).map(agent => {
      const name = namesPending ? 'Agent name unavailable' : participantRosterName(currentNames?.get(agent.participantId) ?? agent.displayName, 'Agent');
      return <span key={agent.participantId} className="channel-participants__chip" title={`${name} · ${agent.connection}`}>
        <span className="channel-participants__avatar" aria-hidden="true">{name.trim().slice(0, 1).toLocaleUpperCase()}</span><span className="channel-participants__name">{name}</span>
      </span>;
    })}
    {agents.length > 4 ? <span className="channel-participants__more">+{agents.length - 4}</span> : null}
  </div>;
}

export function ChannelScreen({ title, description, theme = 'dark', controller, viewerOwnerId, viewerName, currentNames, namesPending, renameAgent, renameScope,
  renderTimeline, renderShare, renderHeaderActions, onBack, embedded = false }: ChannelScreenProps) {
  const [toolbarTarget, setToolbarTarget] = useState<HTMLElement | null>(null);
  const [rosterOpen, setRosterOpen] = useState(false);
  const roster = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!embedded) { setToolbarTarget(null); return; }
    const hosted = document.getElementById('khala-channel-toolbar');
    if (hosted) { setToolbarTarget(hosted); return; }
    const narrow = window.matchMedia('(max-width: 959px)');
    const update = () => setToolbarTarget(narrow.matches ? document.getElementById('khala-channel-toolbar-mobile') : null);
    narrow.addEventListener('change', update);
    update();
    return () => narrow.removeEventListener('change', update);
  }, [embedded]);
  const toolbar = <div className="channel-toolbar">
    {onBack ? <button type="button" className="conversation-thread__back" onClick={onBack} aria-label="All conversations">‹</button> : null}
    <details ref={roster} className="channel-roster" onToggle={event => setRosterOpen(event.currentTarget.open)} onKeyDown={event => {
      if (event.key === 'Escape' && roster.current?.open) { event.preventDefault(); roster.current.open = false; roster.current.querySelector('summary')?.focus(); }
    }}>
      <summary aria-label={`Channel participants and agents for ${title}`}><span className="channel-roster__summary">{toolbarTarget ? <h1 dir="auto">{title}</h1> : <h2 dir="auto">{title}</h2>}<ChannelParticipants controller={controller} {...(currentNames ? { currentNames } : {})} {...(namesPending !== undefined ? { namesPending } : {})} {...(description ? { description } : {})} {...(viewerName ? { viewerName } : {})} /></span><span className="channel-roster__chevron" aria-hidden="true">⌄</span></summary>
      <div className="channel-roster__panel" aria-label="Channel participants and agents">
        {viewerName ? <div className="channel-roster__viewer"><span className="channel-participants__avatar channel-participants__avatar--human" aria-hidden="true">{participantRosterName(viewerName, 'You').trim().slice(0, 1).toLocaleUpperCase()}</span><span>{participantRosterName(viewerName, 'You')}</span><span className="channel-roster__role">You</span></div> : null}
        {rosterOpen ? <AgentPresencePanel controller={controller} {...(viewerOwnerId ? { viewerOwnerId } : {})} {...(currentNames ? { currentNames } : {})} {...(namesPending !== undefined ? { namesPending } : {})} {...(renameScope ? { renameScope } : {})} {...(renameAgent ? { renameAgent } : {})} /> : null}
      </div>
    </details>
    <div className="channel-toolbar__actions">{renderHeaderActions?.()}{renderShare?.()}</div>
  </div>;
  const content = (
    <div className={`channel-page${toolbarTarget ? ' channel-page--topbar' : ''}`}><KhalaPageFrame model={{ title, labelledBy: 'khala-channel-title' }}>
        {toolbarTarget ? createPortal(toolbar, toolbarTarget) : null}
        <ConversationLayout inThread thread={<ChatThread title={title} headerContent={toolbarTarget ? null : toolbar}>
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
