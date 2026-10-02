// The roster disclosure (RECREATION-SPEC §6, M1 form per §22) and the
// rename section the agent detail pane shows for the viewer's own agents.

import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import type { ListeningMode } from '@khala/contracts/m1/listening-mode';
import type { ParticipantId } from '@khala/contracts/messaging/ids';
import { AGENT_NAME_MAX, checkName, type NameError } from '@khala/contracts/m1/names';
import { Avatar } from '../../ui/khala/Avatar';
import { harnessLogo, initials } from '../../ui/khala/identity';
import { AgentIcon, AsyncIcon, PencilIcon, SteerIcon, SyncIcon } from '../../ui/khala/icons';
import { Popover } from '../../ui/khala/Popover';
import { Segmented } from '../../ui/khala/Segmented';
import type { AgentMember, ChannelMembers, HumanMember } from './members';
import { HARNESS_NAMES, ownerOfLabel } from './roster-model';

export type RenameAgentResult = { kind: 'ok'; name: string } | {
  kind: 'error';
  code: 'invalid_name' | 'name_taken' | 'not_owner' | 'not_found' | 'signed_out' | 'unavailable';
  reason?: NameError;
};
export type RenameAgentHandler = (participantId: ParticipantId, name: string, signal?: AbortSignal) => Promise<RenameAgentResult>;

const NAME_ERRORS: Record<NameError, string> = {
  too_short: 'At least 2 characters.',
  too_long: 'At most 40 characters.',
  invalid_characters: 'Use letters, numbers, . _ or -, starting and ending with a letter or number.',
  reserved: 'Choose a name that does not imply an official role.',
};

function renameError(result: Extract<RenameAgentResult, { kind: 'error' }>): string {
  if (result.code === 'invalid_name' && result.reason) return NAME_ERRORS[result.reason];
  if (result.code === 'name_taken') return 'That name is taken.';
  if (result.code === 'not_owner') return 'You can only rename your own agents.';
  return 'Couldn’t rename. Try again.';
}

/**
 * Checks `draft` with the shared handle rules and, if it is a new valid name,
 * renames. Returns the name the server stored, or the message to show.
 */
export async function submitRename(participantId: ParticipantId, currentName: string, draft: string,
  renameAgent: RenameAgentHandler, signal?: AbortSignal): Promise<{ kind: 'ok'; name: string } | { kind: 'error'; message: string }> {
  const checked = checkName(draft, 'agent');
  if (!checked.ok) return { kind: 'error', message: NAME_ERRORS[checked.error] };
  if (checked.name === currentName) return { kind: 'error', message: 'This agent already has that name.' };
  try {
    const result = await renameAgent(participantId, checked.name, signal);
    return result.kind === 'ok' ? result : { kind: 'error', message: renameError(result) };
  } catch {
    return { kind: 'error', message: 'Couldn’t rename. Try again.' };
  }
}

/** Renames one of the viewer's agents everywhere, through the global rename API. */
export function RenameAgent({ participantId, name, renameAgent, autoFocus = false }: Readonly<{
  participantId: ParticipantId;
  name: string;
  renameAgent: RenameAgentHandler;
  autoFocus?: boolean;
}>) {
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(name);
  // The pane is laid out a render after it mounts, so focus on the next frame rather than with `autoFocus`.
  useEffect(() => {
    if (!autoFocus) return undefined;
    const frame = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [autoFocus]);
  const errorId = useId();
  const [status, setStatus] = useState('');
  const [sending, setSending] = useState(false);
  // Aborts an in-flight rename when the pane closes or switches participant.
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const checked = checkName(draft, 'agent');
  const message = checked.ok ? status : NAME_ERRORS[checked.error];

  async function submit(): Promise<void> {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setSending(true);
    setStatus('');
    const result = await submitRename(participantId, name, draft, renameAgent, controller.signal);
    if (controller.signal.aborted) return;
    setSending(false);
    // The server's name wins over what was typed.
    if (result.kind === 'ok') setDraft(result.name);
    else setStatus(result.message);
  }
  return <form className="kh-d-rename" noValidate onSubmit={event => { event.preventDefault(); if (checked.ok && !sending) void submit(); }}>
    <div className="kh-row2">
      <input className="kh-txt" aria-label={`Name for ${name}`} aria-describedby={message ? errorId : undefined}
        aria-invalid={checked.ok ? undefined : true} value={draft}
        onChange={event => { setDraft(event.target.value); setStatus(''); }} maxLength={AGENT_NAME_MAX} autoCapitalize="none" autoComplete="off"
        spellCheck={false} ref={input} />
      <button type="submit" className="kh-btn pri" disabled={!checked.ok || sending}>{sending ? 'Renaming…' : 'Rename'}</button>
    </div>
    {message ? <p className="kh-d-rename-err" id={errorId} role="alert">{message}</p> : null}
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
function ModeControl({ agent, mode, onSetMode, rename, children }: Readonly<{
  agent: AgentMember;
  mode: ListeningMode;
  onSetMode: SetModeHandler;
  /** The row's Rename button, placed before the mode control. */
  rename: ReactNode;
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

  /** A menu pick closes the menu and returns focus to the trigger, as Escape does. */
  function chooseFromMenu(next: ListeningMode): void {
    anchor.current?.focus();
    void choose(next);
  }

  return <>
    <div className="kh-rrow">{children}<span className="kh-racts">
      {rename}
      <Segmented icon label={`Listening mode for ${label}`} value={shown} options={MODES} onChange={value => void choose(value)} />
      <button ref={anchor} type="button" className="kh-ib sm kh-mode-btn" data-tip={modeTip(shown)} aria-haspopup="menu"
        aria-expanded={menuOpen} aria-label={`Listening mode for ${label}: ${modeTip(shown)}`}
        onClick={() => setMenuOpen(open => !open)}><ModeIcon mode={shown} /></button>
      <Popover anchor={anchor} open={menuOpen} menu onClose={() => setMenuOpen(false)}>
        <div role="menu" aria-label={`Listening mode for ${label}`} onKeyDown={moveFocus}>
          {MODE_COPY.map(([value, name, desc]) => <button key={value} ref={value === shown ? activeItem : undefined} type="button"
            role="menuitemradio" aria-checked={value === shown} className={`kh-mi${value === shown ? ' on' : ''}`}
            data-v={value} onClick={() => chooseFromMenu(value)}><ModeIcon mode={value} />{name}<em>{desc}</em></button>)}
        </div>
      </Popover>
    </span></div>
    <p className="kh-roster-status kh-mode-status" role="status" hidden={!status}>{status}</p>
  </>;
}

function AgentRow({ agent, mode, onOpen, onRename, onSetMode }: Readonly<{
  agent: AgentMember;
  mode: ListeningMode;
  onOpen(participantId: string): void;
  onRename?: ((participantId: string) => void) | undefined;
  onSetMode?: SetModeHandler | undefined;
}>) {
  const label = agentLabel(agent);
  const opener = <button type="button" className="kh-rai" data-kh-agent={agent.participantId} onClick={() => onOpen(agent.participantId)}>
    <MemberAvatar member={agent} /><span><AgentName agent={agent} /><em>{harnessName(agent)}</em></span>
  </button>;
  const rename = agent.isViewerOwned && onRename ? <button type="button" className="kh-ib sm kh-rename-btn" aria-label={`Rename ${label}`}
    data-tip="Rename" onClick={() => onRename(agent.participantId)}><PencilIcon /></button> : null;
  if (agent.isViewerOwned && onSetMode) {
    return <ModeControl agent={agent} mode={mode} onSetMode={onSetMode} rename={rename}>{opener}</ModeControl>;
  }
  return <div className="kh-rrow">
    {opener}
    <span className="kh-racts">{agent.isViewerOwned ? <>
      {rename}
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
  /** Opens the rename field for one of the viewer's agents; no Rename buttons without it. */
  onRename?: ((participantId: string) => void) | undefined;
  /** The Add agent popover body on the viewer's row. */
  renderAddAgent?: (() => ReactNode) | undefined;
  /** An agent's reported listening mode; `sync` when absent. */
  modeFor?: ((participantId: string) => ListeningMode) | undefined;
  /** Makes the viewer's agents' mode controls live. */
  onSetMode?: SetModeHandler | undefined;
}>;

/** The roster tree: one group per human, each with the agents it owns. */
export function ChannelRoster({ members, phase, onOpen, onRename, renderAddAgent, modeFor, onSetMode }: ChannelRosterProps) {
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
            <Avatar kind="human" static label={group.human.displayName} hue={agents[0]?.ownerHue ?? 0} initials={agents[0]?.ownerInitials ?? '?'} />
            <span><b>{group.human.displayName}</b><em>Not in this channel</em></span>{agentCount}
          </div>}
          {human?.isViewer && renderAddAgent ? <AddAgent renderAddAgent={renderAddAgent} /> : null}
        </div>
        {agents.length > 0 ? <div className="kh-ra">{agents.map(agent => <AgentRow key={agent.participantId} agent={agent}
          mode={modeFor?.(agent.participantId) ?? 'sync'} onOpen={onOpen} onRename={onRename} onSetMode={onSetMode} />)}</div> : null}
      </div>;
    })}
  </>;
}

/** @deprecated Use `ChannelRoster`; the agent list is now the roster tree. */
export const AgentPresencePanel = ChannelRoster;
export type AgentPresencePanelProps = ChannelRosterProps;
