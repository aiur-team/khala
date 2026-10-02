// The composer's `@mention` suggestions: a listbox anchored above the
// composer. Options keep the textarea focused (and a phone keyboard open) by
// cancelling pointer and mouse down; a click or tap picks.

import type { CSSProperties, SyntheticEvent } from 'react';
import { harnessLogo, initials } from './identity';
import type { MentionTarget } from './MentionChips';
import { mentionKindLabel } from './mention-autocomplete';

export const MENTION_LIST_ID = 'kh-mention-list';

export const mentionOptionId = (target: MentionTarget) => `kh-mention-opt-${target.id}`;

const keepFocus = (event: SyntheticEvent) => event.preventDefault();

function Avatar({ target }: Readonly<{ target: MentionTarget }>) {
  const swatch: Readonly<Record<string, string>> = target.swatch ? { '--hc': target.swatch } : {};
  if (target.kind === 'human') return <i style={{ '--oh': target.hue, ...swatch } as CSSProperties}>{target.ownerInitials}</i>;
  const logo = target.harness ? harnessLogo(target.harness) : null;
  if (logo) return <img src={logo} alt="" />;
  return <i style={{ '--oh': target.ownerHue, ...swatch } as CSSProperties}>{initials(target.label)}</i>;
}

export function MentionPopup({ options, active, onPick, onHover, targets }: Readonly<{
  options: readonly MentionTarget[];
  active: number;
  onPick(target: MentionTarget): void;
  onHover(index: number): void;
  targets: readonly MentionTarget[];
}>) {
  if (options.length === 0) return null;
  return <ul role="listbox" id={MENTION_LIST_ID} className="kh-mpop" aria-label="Mention suggestions">
    {options.map((target, index) => <li key={target.id} role="option" id={mentionOptionId(target)}
      aria-selected={index === active} className="kh-mpop-opt" data-kh-mention-option={target.id}
      onPointerDown={keepFocus} onMouseDown={keepFocus} onMouseEnter={() => onHover(index)} onClick={() => onPick(target)}>
      <Avatar target={target} />
      <b>{target.display}</b>
      <em>{mentionKindLabel(target, targets)}</em>
    </li>)}
  </ul>;
}
