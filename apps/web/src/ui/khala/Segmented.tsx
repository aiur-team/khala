// Segmented control (`khSeg`, RECREATION-SPEC §12.2): a radiogroup of buttons.

import type { ReactNode } from 'react';

export type SegmentOption<Value extends string> = Readonly<{
  value: Value;
  label: ReactNode;
  /** Tooltip and accessible name, for icon-only segments. */
  tip?: string;
}>;

export function Segmented<Value extends string>({ options, value, onChange, icon = false, full = false, locked = false, title, label }: Readonly<{
  options: readonly SegmentOption<Value>[];
  value: Value;
  onChange?(value: Value): void;
  /** Icon-only segments (`.kh-seg.ic`). */
  icon?: boolean;
  /** Stretches to the popover width (`.kh-seg.full`). */
  full?: boolean;
  /** Disabled with the lock treatment (`.kh-seg.lock`). */
  locked?: boolean;
  /** Every button's `title`, e.g. `Coming soon` on a locked M2 control. */
  title?: string;
  /** The radiogroup's accessible name. */
  label?: string;
}>) {
  return <span className={`kh-seg${icon ? ' ic' : ''}${full ? ' full' : ''}${locked ? ' lock' : ''}`} role="radiogroup"
    {...(label ? { 'aria-label': label } : {})}>
    {options.map(option => <button key={option.value} type="button" role="radio" aria-checked={option.value === value}
      className={option.value === value ? 'on' : ''} data-v={option.value}
      {...(option.tip ? { 'data-tip': option.tip, 'aria-label': option.tip } : {})} {...(title ? { title } : {})}
      disabled={locked} onClick={() => onChange?.(option.value)}>{option.label}</button>)}
  </span>;
}
