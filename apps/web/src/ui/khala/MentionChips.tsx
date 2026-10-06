// Recipient (mention) chips above the composer (RECREATION-SPEC §9,
// `khRenderTo` source:4194-4205). Clicking a chip inserts `@label `.

import { Fragment, type CSSProperties } from 'react';
import { ChipsToggleIcon } from './icons';
import { harnessLogo } from './identity';

export type MentionTarget = Readonly<{
  /** Participant id. */
  id: string;
  kind: 'human' | 'agent';
  /** Inserted after `@`: the agent label (e.g. `Claude`) or the human's first name. */
  label: string;
  /** Chip text after `@`: the agent label plus an optional ` #suffix`, or the human's first name. */
  display: string;
  hue: number;
  ownerHue: number;
  /** The human's (an agent's: its owner's) resolved `tint`, the badge fill under white initials; absent falls back to the hue. */
  swatch?: string;
  /** An agent's owner initials; a human's own. */
  ownerInitials: string;
  harness?: string;
  ownerId: string;
  /** The viewer's own human entry. */
  isViewer: boolean;
}>;

/** Chips shown before the `+N` toggle. */
const FLAT_LIMIT = 3;

/**
 * `khInsert` (source:4344): append `@label `, first adding a space when the
 * draft is non-empty and doesn't end in whitespace.
 */
export function insertMention(value: string, label: string): string {
  return `${value && !/\s$/u.test(value) ? `${value} ` : value}@${label} `;
}

export type MentionGroup = Readonly<{ human: MentionTarget | null; agents: readonly MentionTarget[] }>;

/**
 * Groups by owning human: the viewer first, then other humans in input order.
 * Agents whose owner has no human entry trail in a group of their own.
 */
export function mentionGroups(targets: readonly MentionTarget[]): readonly MentionGroup[] {
  const humans = targets.filter(target => target.kind === 'human');
  const ordered = [...humans.filter(human => human.isViewer), ...humans.filter(human => !human.isViewer)];
  const agentsOf = (ownerId: string) => targets.filter(target => target.kind === 'agent' && target.ownerId === ownerId);
  const groups: MentionGroup[] = ordered.map(human => ({ human, agents: agentsOf(human.ownerId) }));
  const owned = new Set(ordered.map(human => human.ownerId));
  for (const target of targets) {
    if (target.kind !== 'agent' || owned.has(target.ownerId)) continue;
    owned.add(target.ownerId);
    groups.push({ human: null, agents: agentsOf(target.ownerId) });
  }
  return groups;
}

/** The flat chip order: each group's human chip (never the viewer's), then its agents. */
export function flatMentionOrder(targets: readonly MentionTarget[]): readonly MentionTarget[] {
  return mentionGroups(targets).flatMap(group =>
    group.human && !group.human.isViewer ? [group.human, ...group.agents] : group.agents);
}

function Chip({ target, onPick }: Readonly<{ target: MentionTarget; onPick(target: MentionTarget): void }>) {
  const swatch: Readonly<Record<string, string>> = target.swatch ? { '--hc': target.swatch } : {};
  if (target.kind === 'human') {
    const style = { '--oh': target.hue, ...swatch } as CSSProperties;
    if (target.isViewer) return <span className="kh-chip kh-chip-h kh-chip-me" style={style}><i>{target.ownerInitials}</i>You</span>;
    return <button type="button" className="kh-chip kh-chip-h" style={style} data-kh-mention={target.id} onClick={() => onPick(target)}>
      <i>{target.ownerInitials}</i>@{target.display}
    </button>;
  }
  const logo = target.harness ? harnessLogo(target.harness) : null;
  return <button type="button" className="kh-chip kh-chip-a" style={{ '--oh': target.ownerHue, ...swatch } as CSSProperties} data-kh-mention={target.id} onClick={() => onPick(target)}>
    {logo ? <img src={logo} alt="" /> : null}@{target.display}<i>{target.ownerInitials}</i>
  </button>;
}

export function MentionChips({ targets, value, onChange, open, onOpenChange }: Readonly<{
  targets: readonly MentionTarget[];
  value: string;
  onChange(value: string): void;
  open: boolean;
  onOpenChange(open: boolean): void;
}>) {
  const flat = flatMentionOrder(targets);
  if (flat.length === 0) return null;
  const pick = (target: MentionTarget) => onChange(insertMention(value, target.label));
  const overflow = flat.length > FLAT_LIMIT;
  const expanded = open && overflow;
  const toggle = overflow
    ? <button type="button" className="kh-to-tog" aria-expanded={expanded} onClick={() => onOpenChange(!expanded)}
      aria-label={expanded ? 'Show fewer mentions' : `Show ${flat.length - FLAT_LIMIT} more mentions`}>
      {expanded ? 'Less' : `+${flat.length - FLAT_LIMIT}`}<ChipsToggleIcon />
    </button>
    : null;

  if (!expanded) {
    return <div className="kh-to">
      <div className="kh-to-flat" role="toolbar" aria-label="Mention">
        {flat.slice(0, FLAT_LIMIT).map(target => <Chip key={target.id} target={target} onPick={pick} />)}
        {toggle}
      </div>
    </div>;
  }
  const groups = mentionGroups(targets).filter(group => !group.human?.isViewer || group.agents.length > 0);
  return <div className="kh-to is-open">
    <div className="kh-to-grid" role="group" aria-label="Mention">
      {groups.map(group => <Fragment key={group.human?.id ?? group.agents[0]!.ownerId}>
        <div className="kh-to-h">{group.human ? <Chip target={group.human} onPick={pick} /> : null}</div>
        <div className="kh-to-ags">{group.agents.map(target => <Chip key={target.id} target={target} onPick={pick} />)}</div>
      </Fragment>)}
    </div>
    <div className="kh-to-foot"><span>Mention a human or agent</span>{toggle}</div>
  </div>;
}
