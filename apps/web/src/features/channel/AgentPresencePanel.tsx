// The roster disclosure (RECREATION-SPEC §6, M1 form per §22) and the
// rename section the agent detail pane shows for the viewer's own agents.

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { ParticipantId } from '@khala/contracts/messaging/ids';
import { validateAgentName } from '@khala/contracts/messaging/agent-names';
import { Avatar } from '../../ui/khala/Avatar';
import { harnessLogo, initials } from '../../ui/khala/identity';
import { AgentIcon, AsyncIcon, SteerIcon, SyncIcon } from '../../ui/khala/icons';
import { COMING_SOON } from '../../ui/khala/InvitePopover';
import { Popover } from '../../ui/khala/Popover';
import { Segmented } from '../../ui/khala/Segmented';
import type { AgentMember, ChannelMembers, HumanMember } from './members';
import { HARNESS_NAMES, ownerOfLabel } from './roster-model';

type PendingRename = { name: string; clientTxnId: string };

function readPending(key: string): PendingRename | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!value || typeof value !== 'object' || !('name' in value) || !('clientTxnId' in value)
      || typeof value.name !== 'string' || typeof value.clientTxnId !== 'string'
      || !/^txn_[0-9a-f-]{36}$/u.test(value.clientTxnId)) return null;
    const checked = validateAgentName(value.name);
    return checked.ok && checked.name === value.name ? { name: value.name, clientTxnId: value.clientTxnId } : null;
  } catch { return null; }
}

function writePending(key: string, value: PendingRename | null): boolean {
  try {
    if (value) localStorage.setItem(key, JSON.stringify(value));
    else localStorage.removeItem(key);
    return true;
  } catch { return false; }
}

export type RenameAgentHandler = (participantId: ParticipantId, name: string, clientTxnId: string) => Promise<'accepted' | 'unknown' | 'rejected'>;

/**
 * Renames one of the viewer's agents. An unconfirmed request survives a
 * reload under `storageKey` and is retried with the same `clientTxnId`.
 */
export function RenameAgent({ participantId, name, renameAgent, storageKey }: Readonly<{
  participantId: ParticipantId;
  name: string;
  renameAgent: RenameAgentHandler;
  storageKey: string;
}>) {
  const [pending, setPending] = useState<PendingRename | null>(() => readPending(storageKey));
  const [draft, setDraft] = useState(pending?.name ?? name);
  const [status, setStatus] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!pending || name !== pending.name) return;
    setStatus('');
    setPending(null);
    writePending(storageKey, null);
  }, [name, pending, storageKey]);

  async function submit(): Promise<void> {
    const checked = validateAgentName(draft);
    if (!checked.ok) {
      setStatus(checked.error === 'blank' ? 'Enter a name.' : checked.error === 'too_long' ? 'Name is too long.'
        : checked.error === 'reserved' ? 'Choose a name that does not imply an official role.' : 'Remove invisible or control characters.');
      return;
    }
    if (checked.name === name && pending === null) { setStatus('This agent already has that name.'); return; }
    const request = pending ?? { name: checked.name, clientTxnId: `txn_${crypto.randomUUID()}` };
    if (pending && pending.name !== checked.name) { setStatus('Check the previous rename before choosing another name.'); return; }
    if (!writePending(storageKey, request)) { setStatus('This browser cannot safely keep the retry request. Check browser storage.'); return; }
    setPending(request);
    setSending(true);
    setStatus('Waiting for the channel to confirm the name…');
    try {
      const result = await renameAgent(participantId, request.name, request.clientTxnId);
      if (result === 'rejected') { writePending(storageKey, null); setPending(null); setStatus('Name change was refused. Check your channel access and try again.'); }
      else if (result === 'unknown') setStatus('Delivery is unknown. Check delivery using the same request.');
    } catch {
      setStatus('Delivery is unknown. Check delivery using the same request.');
    } finally {
      setSending(false);
    }
  }
  return <form className="kh-d-rename" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <div className="kh-row2">
      <input className="kh-txt" aria-label={`Name for ${name}`} value={draft} onChange={event => setDraft(event.target.value)} maxLength={80} />
      <button type="submit" className="kh-btn pri" disabled={sending}>{pending ? 'Check delivery' : 'Rename'}</button>
    </div>
    {status ? <p role="alert">{status}</p> : null}
  </form>;
}

/** Static or interactive avatar for a member. */
export function MemberAvatar({ member, interactive = false, onClick }: Readonly<{
  member: HumanMember | AgentMember;
  interactive?: boolean;
  onClick?: () => void;
}>) {
  const shared = interactive ? { onClick: () => onClick?.() } : { static: true as const };
  if (member.kind === 'human') return <Avatar kind="human" label={member.name} hue={member.hue} initials={member.initials} {...shared} />;
  return <Avatar kind="agent" label={agentLabel(member)} hue={member.hue} ownerHue={member.ownerHue}
    ownerInitials={member.ownerInitials} logo={member.harness ? harnessLogo(member.harness) : null}
    initials={initials(member.name)} {...shared} />;
}

/** `Claude`, or `Claude #2` when another agent has the same name. */
export function agentLabel(agent: AgentMember): string {
  return agent.idBadge === null ? agent.name : `${agent.name} #${agent.idBadge}`;
}

/** `<b>{label}{.kh-id}</b>` */
export function AgentName({ agent }: Readonly<{ agent: AgentMember }>) {
  return <b>{agent.name}{agent.idBadge === null ? null
    : <span className="kh-id" style={{ '--h': agent.hue } as CSSProperties}>#{agent.idBadge}</span>}</b>;
}

export const harnessName = (agent: AgentMember) => agent.harness ? HARNESS_NAMES[agent.harness] : 'Agent';

const SYNC_TIP = 'Sync · next turn';
const MODES = [
  { value: 'steer', label: <SteerIcon />, tip: 'Steer · interrupts' },
  { value: 'sync', label: <SyncIcon />, tip: SYNC_TIP },
  { value: 'async', label: <AsyncIcon />, tip: 'Async · on demand' },
] as const;

function AgentRow({ agent, onOpen }: Readonly<{ agent: AgentMember; onOpen(participantId: string): void }>) {
  return <div className="kh-rrow">
    <button type="button" className="kh-rai" data-kh-agent={agent.participantId} onClick={() => onOpen(agent.participantId)}>
      <MemberAvatar member={agent} /><span><AgentName agent={agent} /><em>{harnessName(agent)}</em></span>
    </button>
    <span className="kh-racts">{agent.isViewerOwned ? <>
      {/* Listening modes are M2 (§22): shown locked on Sync. */}
      <Segmented icon locked title={COMING_SOON} label={`Listening mode for ${agentLabel(agent)}`} value="sync" options={MODES} />
      <button type="button" className="kh-ib sm kh-mode-btn" disabled title={COMING_SOON} data-tip={SYNC_TIP}
        aria-label={`Listening mode for ${agentLabel(agent)}: ${SYNC_TIP}`}><SyncIcon /></button>
    </> : <span className="kh-mode-ro" role="img" data-tip={SYNC_TIP} aria-label={SYNC_TIP}><SyncIcon /></span>}</span>
  </div>;
}

function AddAgent({ renderAddAgent }: Readonly<{ renderAddAgent: () => ReactNode }>) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return <span className="kh-racts">
    <button ref={anchor} type="button" className="kh-ib sm" data-tip="Add agent" aria-label="Add agent" aria-expanded={open}
      onClick={() => setOpen(current => !current)}><AgentIcon /></button>
    <Popover anchor={anchor} open={open} onClose={() => setOpen(false)}>{renderAddAgent()}</Popover>
  </span>;
}

export type ChannelRosterProps = Readonly<{
  members: ChannelMembers;
  phase: 'loading' | 'ready' | 'unavailable';
  onOpen(participantId: string): void;
  /** The Add agent popover body on the viewer's row. */
  renderAddAgent?: (() => ReactNode) | undefined;
}>;

/** The roster tree: one group per human, each with the agents it owns. */
export function ChannelRoster({ members, phase, onOpen, renderAddAgent }: ChannelRosterProps) {
  const agentsById = new Map(members.agents.map(agent => [agent.participantId as string, agent]));
  const humansById = new Map([members.viewer, ...members.humans].map(human => [human.ownerId, human]));
  return <>
    {phase === 'loading' ? <p className="kh-roster-status" role="status">Checking participants…</p> : null}
    {phase === 'unavailable' ? <p className="kh-roster-status" role="status">Agent presence is unavailable right now.</p> : null}
    {members.groups.map(group => {
      const human = 'notInChannel' in group ? null : humansById.get(group.human.ownerId) ?? null;
      const agents = group.agents.flatMap(agent => agentsById.get(agent.participantId) ?? []);
      return <div key={`${group.human.ownerId}:${'notInChannel' in group ? 'absent' : 'member'}`} className="kh-rg">
        <div className="kh-rrow">
          {human ? <button type="button" className="kh-rh" data-kh-human={human.participantId} onClick={() => onOpen(human.participantId)}>
            <MemberAvatar member={human} /><span><b>{human.isViewer ? 'You' : human.name}</b><em>{ownerOfLabel(agents.length)}</em></span>
          </button> : <div className="kh-rh">
            <Avatar kind="human" static label={group.human.displayName} hue={agents[0]?.ownerHue ?? 0} initials={agents[0]?.ownerInitials ?? '?'} />
            <span><b>{group.human.displayName}</b><em>Not in this channel</em></span>
          </div>}
          {human?.isViewer && renderAddAgent ? <AddAgent renderAddAgent={renderAddAgent} /> : null}
        </div>
        {agents.length > 0 ? <div className="kh-ra">{agents.map(agent => <AgentRow key={agent.participantId} agent={agent} onOpen={onOpen} />)}</div> : null}
      </div>;
    })}
  </>;
}

/** @deprecated Use `ChannelRoster`; the agent list is now the roster tree. */
export const AgentPresencePanel = ChannelRoster;
export type AgentPresencePanelProps = ChannelRosterProps;
