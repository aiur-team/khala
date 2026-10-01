import { AgentPresencePanel } from './AgentPresencePanel';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AiurShell } from '../../shell/AiurShell';
import { KhalaPageFrame } from '../../shell/KhalaPageFrame';
import type { ThemeChoice } from '../../shell/types';
import type { ChannelAgentView, ChannelController } from './controller';
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
  humanParticipants?: readonly Readonly<{ participantId: ParticipantId; displayName: string }>[];
  currentNames?: ReadonlyMap<ParticipantId, string>;
  namesPending?: boolean;
  renameAgent?: (participantId: ParticipantId, name: string, clientTxnId: string) => Promise<'accepted' | 'unknown' | 'rejected'>;
  renameScope?: string;
  renderTimeline: () => ReactNode;
  renderShare?: () => ReactNode;
  renderHeaderActions?: () => ReactNode;
  renderDetailsActions?: (open: boolean) => ReactNode;
  renderOwnerControls?: (agent: ChannelAgentView) => ReactNode;
  showPresence?: boolean;
  onBack?: () => void;
  embedded?: boolean;
}

/** @deprecated Use `ChannelScreenProps`. Kept through the first tagged release containing #163. */
export type RoomScreenProps = ChannelScreenProps;

function ChannelParticipants({ controller, currentNames, description, viewerName, humanParticipants }: Pick<ChannelScreenProps, 'controller' | 'currentNames' | 'description' | 'viewerName' | 'humanParticipants'>) {
  const { agents, phase } = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  return <div className="channel-participants" aria-label="Channel participants">
    {description ? <span className="channel-participants__context">{description}</span> : null}
    {viewerName ? <span className="channel-participants__chip" title={`${participantRosterName(viewerName, 'You')} · human`}><span className="channel-participants__avatar channel-participants__avatar--human" aria-hidden="true">{participantRosterName(viewerName, 'You').trim().slice(0, 1).toLocaleUpperCase()}</span><span className="channel-participants__name">{participantRosterName(viewerName, 'You')}</span></span> : null}
    {humanParticipants?.map(participant => {
      const name = participantRosterName(participant.displayName, 'Channel member');
      return <span key={participant.participantId} className="channel-participants__chip" title={`${name} · human`}><span className="channel-participants__avatar channel-participants__avatar--human" aria-hidden="true">{name.trim().slice(0, 1).toLocaleUpperCase()}</span><span className="channel-participants__name">{name}</span></span>;
    })}
    {phase === 'loading' ? <span role="status">Checking participants…</span> : null}
    {phase === 'unavailable' ? <span role="status">Participants unavailable</span> : null}
    {agents.slice(0, 4).map(agent => {
      const name = participantRosterName(currentNames?.get(agent.participantId) ?? agent.displayName, 'Agent');
      const state = agent.connection === 'unknown' ? 'Unavailable' : agent.connection === 'connected' ? 'Connected'
        : agent.connection === 'stale' ? 'Stale' : 'Offline';
      return <span key={agent.participantId} className="channel-participants__chip" title={`${name} · ${state}`}>
        <span className="channel-participants__avatar" aria-hidden="true">{name.trim().slice(0, 1).toLocaleUpperCase()}</span><span className="channel-participants__name">{name}</span>
        <span className="channel-participants__state">{state}</span>
      </span>;
    })}
    {agents.length > 4 ? <span className="channel-participants__more">+{agents.length - 4}</span> : null}
  </div>;
}

export function ChannelScreen({ title, description, theme = 'dark', controller, viewerOwnerId, viewerName, humanParticipants, currentNames, namesPending, renameAgent, renameScope,
  renderTimeline, renderShare, renderHeaderActions, renderDetailsActions, renderOwnerControls, onBack, embedded = false }: ChannelScreenProps) {
  const [toolbarTarget, setToolbarTarget] = useState<HTMLElement | null>(null);
  const [rosterOpen, setRosterOpen] = useState(false);
  const roster = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!embedded) { setToolbarTarget(null); return; }
    setToolbarTarget(document.getElementById('khala-channel-toolbar'));
  }, [embedded]);
  useEffect(() => {
    if (!rosterOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!roster.current?.contains(event.target as Node)) {
        roster.current!.open = false;
        requestAnimationFrame(() => {
          if (roster.current?.contains(document.activeElement)) roster.current.querySelector('summary')?.focus();
        });
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [rosterOpen]);
  const toolbar = <div className="channel-toolbar">
    {onBack ? <button type="button" className="conversation-thread__back" onClick={onBack} aria-label="All conversations">‹</button> : null}
    <details ref={roster} className="channel-roster" onToggle={event => setRosterOpen(event.currentTarget.open)} onKeyDown={event => {
      if (event.key === 'Escape' && roster.current?.open) { event.preventDefault(); roster.current.open = false; roster.current.querySelector('summary')?.focus(); }
    }}>
      <summary aria-label={`Channel participants and agents for ${title}`}><span className="channel-roster__summary">{toolbarTarget ? <h1 dir="auto">{title}</h1> : <h2 dir="auto">{title}</h2>}<ChannelParticipants controller={controller} {...(humanParticipants ? { humanParticipants } : {})} {...(currentNames ? { currentNames } : {})} {...(description ? { description } : {})} {...(viewerName ? { viewerName } : {})} /></span><span className="channel-roster__chevron" aria-hidden="true">⌄</span></summary>
      <div className="channel-roster__panel" aria-label="Channel participants and agents">
        {viewerName ? <div className="channel-roster__viewer"><span className="channel-participants__avatar channel-participants__avatar--human" aria-hidden="true">{participantRosterName(viewerName, 'You').trim().slice(0, 1).toLocaleUpperCase()}</span><span className="channel-roster__viewer-name">{participantRosterName(viewerName, 'You')}<small>Human</small></span><span className="channel-roster__role">You</span></div> : null}
        {humanParticipants?.map(participant => <div key={participant.participantId} className="channel-roster__viewer"><span className="channel-participants__avatar channel-participants__avatar--human" aria-hidden="true">{participantRosterName(participant.displayName, 'Channel member').trim().slice(0, 1).toLocaleUpperCase()}</span><span className="channel-roster__viewer-name">{participantRosterName(participant.displayName, 'Channel member')}<small>Human</small></span></div>)}
        {rosterOpen ? <AgentPresencePanel controller={controller} {...(viewerOwnerId ? { viewerOwnerId } : {})} {...(currentNames ? { currentNames } : {})} {...(namesPending !== undefined ? { namesPending } : {})} {...(renameScope ? { renameScope } : {})} {...(renameAgent ? { renameAgent } : {})} {...(renderOwnerControls ? { renderOwnerControls } : {})} /> : null}
        {renderDetailsActions?.(rosterOpen)}
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
