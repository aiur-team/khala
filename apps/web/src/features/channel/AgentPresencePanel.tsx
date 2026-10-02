// The roster disclosure (RECREATION-SPEC §6, M1 form per §22) and the
// rename section the agent detail pane shows for the viewer's own agents.

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import type { ListeningMode } from '@khala/contracts/m1/listening-mode';
import type { ParticipantId } from '@khala/contracts/messaging/ids';
import { validateAgentName } from '@khala/contracts/messaging/agent-names';
import { Avatar } from '../../ui/khala/Avatar';
import { variantSwatch } from '../../ui/khala/human-colors';
import { harnessLogo, initials } from '../../ui/khala/identity';
import { AgentIcon, AsyncIcon, SteerIcon, SyncIcon } from '../../ui/khala/icons';
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
  if (member.kind === 'human') {
    return <Avatar kind="human" label={member.name} hue={member.hue} initials={member.initials}
      swatch={variantSwatch(member.color)} tier={member.color?.tier} {...shared} />;
  }
  return <Avatar kind="agent" label={agentLabel(member)} hue={member.hue} ownerHue={member.ownerHue} ownerSwatch={variantSwatch(member.ownerColor)}
    ownerInitials={member.ownerInitials} logo={member.harness ? harnessLogo(member.harness) : null}
    initials={initials(member.name)} {...shared} />;
}

/** `Claude`, or `Claude #a1b2` when another owner has an agent with the same name. */
export function agentLabel(agent: AgentMember): string {
  return agent.idBadge === null ? agent.name : `${agent.name} ${agent.idBadge}`;
}

/** `<b>{label}{.kh-id}</b>` */
export function AgentName({ agent }: Readonly<{ agent: AgentMember }>) {
  return <b>{agent.name}{agent.idBadge === null ? null
    : <span className="kh-id" style={{ '--h': agent.hue } as CSSProperties}>{agent.idBadge}</span>}</b>;
}

export const harnessName = (agent: AgentMember) => agent.harness ? HARNESS_NAMES[agent.harness] : 'Agent';

export type SetModeHandler = (participantId: string, mode: ListeningMode) => Promise<'sent' | 'failed'>;

/** How long a requested mode stays selected before an unconfirmed request reverts. */
export const MODE_CONFIRM_MS = 15_000;

// `KH_MODES` (source:4394): value, label, description.
const MODE_COPY = [['steer', 'Steer', 'interrupts'], ['sync', 'Sync', 'next turn'], ['async', 'Async', 'on demand']] as const;
const MODE_ICONS: Readonly<Record<ListeningMode, () => ReactNode>> = { steer: SteerIcon, sync: SyncIcon, async: AsyncIcon };
const MODE_TIPS = Object.fromEntries(MODE_COPY.map(([value, label, desc]) => [value, `${label} · ${desc}`])) as Readonly<Record<ListeningMode, string>>;
const modeTip = (mode: ListeningMode) => MODE_TIPS[mode];
const MODES = MODE_COPY.map(([value]) => ({ value, label: <ModeIcon mode={value} />, tip: modeTip(value) }));

function ModeIcon({ mode }: Readonly<{ mode: ListeningMode }>) {
  const Icon = MODE_ICONS[mode];
  return <Icon />;
}

/**
 * An owned agent's row with the live mode control. A chosen mode shows as
 * selected until the agent's member state reports it, or reverts after
 * `MODE_CONFIRM_MS`.
 */
function ModeControl({ agent, mode, onSetMode, children }: Readonly<{
  agent: AgentMember;
  mode: ListeningMode;
  onSetMode: SetModeHandler;
  /** The row's opener button. */
  children: ReactNode;
}>) {
  const label = agentLabel(agent);
  const anchor = useRef<HTMLButtonElement>(null);
  const activeItem = useRef<HTMLButtonElement>(null);
  const request = useRef(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pending, setPending] = useState<ListeningMode | null>(null);
  const [status, setStatus] = useState('');
  const shown = pending ?? mode;

  useEffect(() => {
    if (pending === null || mode !== pending) return;
    setPending(null);
    setStatus('');
  }, [mode, pending]);
  useEffect(() => {
    if (pending === null) return undefined;
    const timer = setTimeout(() => {
      request.current += 1;
      setPending(null);
      setStatus(`${label} didn't confirm. It may be offline.`);
    }, MODE_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [label, pending]);
  useEffect(() => {
    if (menuOpen) activeItem.current?.focus();
  }, [menuOpen]);

  function moveFocus(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    items[(at + step + items.length) % items.length]?.focus();
  }

  async function choose(next: ListeningMode): Promise<void> {
    setMenuOpen(false);
    if (next === shown) return;
    const id = ++request.current;
    setPending(next);
    setStatus(`Waiting for ${label} to switch…`);
    const result = await onSetMode(agent.participantId, next).catch(() => 'failed' as const);
    if (result === 'sent' || id !== request.current) return;
    setPending(null);
    setStatus(`Couldn't send the mode change to ${label}. Try again.`);
  }

  return <>
    <div className="kh-rrow">{children}<span className="kh-racts">
      <Segmented icon label={`Listening mode for ${label}`} value={shown} options={MODES} onChange={value => void choose(value)} />
      <button ref={anchor} type="button" className="kh-ib sm kh-mode-btn" data-tip={modeTip(shown)} aria-haspopup="menu"
        aria-expanded={menuOpen} aria-label={`Listening mode for ${label}: ${modeTip(shown)}`}
        onClick={() => setMenuOpen(open => !open)}><ModeIcon mode={shown} /></button>
      <Popover anchor={anchor} open={menuOpen} menu onClose={() => setMenuOpen(false)}>
        <div role="menu" aria-label={`Listening mode for ${label}`} onKeyDown={moveFocus}>
          {MODE_COPY.map(([value, name, desc]) => <button key={value} ref={value === shown ? activeItem : undefined} type="button"
            role="menuitemradio" aria-checked={value === shown} className={`kh-mi${value === shown ? ' on' : ''}`}
            data-v={value} onClick={() => void choose(value)}><ModeIcon mode={value} />{name}<em>{desc}</em></button>)}
        </div>
      </Popover>
    </span></div>
    <p className="kh-roster-status kh-mode-status" role="status" hidden={!status}>{status}</p>
  </>;
}

function AgentRow({ agent, mode, onOpen, onSetMode }: Readonly<{
  agent: AgentMember;
  mode: ListeningMode;
  onOpen(participantId: string): void;
  onSetMode?: SetModeHandler | undefined;
}>) {
  const label = agentLabel(agent);
  const opener = <button type="button" className="kh-rai" data-kh-agent={agent.participantId} onClick={() => onOpen(agent.participantId)}>
    <MemberAvatar member={agent} /><span><AgentName agent={agent} /><em>{harnessName(agent)}</em></span>
  </button>;
  if (agent.isViewerOwned && onSetMode) return <ModeControl agent={agent} mode={mode} onSetMode={onSetMode}>{opener}</ModeControl>;
  return <div className="kh-rrow">
    {opener}
    <span className="kh-racts">{agent.isViewerOwned ? <>
      {/* No mode port (fixtures, harnesses): the reported mode, locked. */}
      <Segmented icon locked label={`Listening mode for ${label}`} value={mode} options={MODES} />
      <button type="button" className="kh-ib sm kh-mode-btn" disabled data-tip={modeTip(mode)}
        aria-label={`Listening mode for ${label}: ${modeTip(mode)}`}><ModeIcon mode={mode} /></button>
    </> : <span className="kh-mode-ro" role="img" data-tip={modeTip(mode)} aria-label={modeTip(mode)}><ModeIcon mode={mode} /></span>}</span>
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
  /** An agent's reported listening mode; `sync` when absent. */
  modeFor?: ((participantId: string) => ListeningMode) | undefined;
  /** Makes the viewer's agents' mode controls live. */
  onSetMode?: SetModeHandler | undefined;
}>;

/** The roster tree: one group per human, each with the agents it owns. */
export function ChannelRoster({ members, phase, onOpen, renderAddAgent, modeFor, onSetMode }: ChannelRosterProps) {
  const agentsById = new Map(members.agents.map(agent => [agent.participantId as string, agent]));
  const humansById = new Map([members.viewer, ...members.humans].map(human => [human.ownerId, human]));
  return <>
    {phase === 'loading' ? <p className="kh-roster-status" role="status">Checking participants…</p> : null}
    {phase === 'unavailable' ? <p className="kh-roster-status" role="status">Agent presence is unavailable right now.</p> : null}
    {members.groups.map(group => {
      const human = 'notInChannel' in group ? null : humansById.get(group.human.ownerId) ?? null;
      const agents = group.agents.flatMap(agent => agentsById.get(agent.participantId) ?? []);
      const agentCount = agents.length > 0 ? <i>{agents.length} {agents.length === 1 ? 'agent' : 'agents'}</i> : null;
      return <div key={`${group.human.ownerId}:${'notInChannel' in group ? 'absent' : 'member'}`} className="kh-rg">
        <div className="kh-rrow">
          {human ? <button type="button" className="kh-rh" data-kh-human={human.participantId} onClick={() => onOpen(human.participantId)}>
            <MemberAvatar member={human} /><span><b>{human.isViewer ? 'You' : human.name}</b>
              {human.email ? <em className="kh-email" title={human.email}>{human.email}</em> : null}<em>{ownerOfLabel(agents.length)}</em></span>{agentCount}
          </button> : <div className="kh-rh">
            <Avatar kind="human" static label={group.human.displayName} hue={agents[0]?.ownerHue ?? 0} initials={agents[0]?.ownerInitials ?? '?'}
              swatch={variantSwatch(agents[0]?.ownerColor)} tier={agents[0]?.ownerColor?.tier} />
            <span><b>{group.human.displayName}</b><em>Not in this channel</em></span>{agentCount}
          </div>}
          {human?.isViewer && renderAddAgent ? <AddAgent renderAddAgent={renderAddAgent} /> : null}
        </div>
        {agents.length > 0 ? <div className="kh-ra">{agents.map(agent => <AgentRow key={agent.participantId} agent={agent}
          mode={modeFor?.(agent.participantId) ?? 'sync'} onOpen={onOpen} onSetMode={onSetMode} />)}</div> : null}
      </div>;
    })}
  </>;
}

/** @deprecated Use `ChannelRoster`; the agent list is now the roster tree. */
export const AgentPresencePanel = ChannelRoster;
export type AgentPresencePanelProps = ChannelRosterProps;
