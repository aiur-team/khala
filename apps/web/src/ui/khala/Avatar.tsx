// Avatars (RECREATION-SPEC §3). Interactive avatars are buttons that open
// detail; list, roster and detail-agent avatars are static spans.

import type { CSSProperties, MouseEventHandler } from 'react';

type Shared = Readonly<{
  /** Renders a decorative `span` instead of a button. */
  static?: boolean;
  /** A grouped thread row: keeps the slot but hides the avatar. */
  ghost?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
}>;

export type AvatarProps =
  | Shared & Readonly<{
    kind: 'agent';
    /** Accessible name, e.g. `Claude #2`. */
    label: string;
    /** The owner's hue: an agent wears its owner's colour (operator request 2026-10-04). */
    hue: number;
    ownerHue: number;
    ownerInitials: string;
    /** The owner's colour, which `ownerHue` alone cannot draw. */
    ownerSwatch?: string | undefined;
    /** The agent's own colour; `ownerSwatch` without it. */
    swatch?: string | undefined;
    ownerHost?: string;
    /** Harness logo URL; `null` renders the agent's initials instead. */
    logo: string | null;
    initials: string;
    /** The `.kh-st` connection dot; omitted while unknown. */
    status?: 'on' | 'off' | 'away' | undefined;
    /** Greys a not-running agent and is its tooltip, e.g. `Not running — last seen 3m ago`. */
    offline?: string | undefined;
  }>
  | Shared & Readonly<{
    kind: 'human'; label: string; hue: number; initials: string;
    /** The human's palette colour, which `hue` alone cannot draw. */
    swatch?: string | undefined;
  }>
  | Readonly<{ kind: 'generic' }>
  | Readonly<{ kind: 'more'; count: number }>;

export function Avatar(props: AvatarProps) {
  if (props.kind === 'generic') return <span className="kh-av kh-gen" aria-hidden="true">#</span>;
  if (props.kind === 'more') return <span className="kh-av kh-more">+{props.count}</span>;

  const offline = props.kind === 'agent' ? props.offline : undefined;
  const className = `kh-av${props.kind === 'human' ? ' kh-hav' : ' kh-aav'}${props.ghost ? ' ghost' : ''}${offline ? ' kh-off' : ''}`;
  // An agent's fill is its own colour (else the owner's swatch), under a white harness glyph.
  const fill = props.kind === 'agent' ? props.swatch ?? props.ownerSwatch : undefined;
  const style = props.kind === 'agent'
    ? { '--h': props.hue, '--oh': props.ownerHue, ...(fill ? { '--hc': fill } : {}) } as CSSProperties
    : { '--oh': props.hue, ...(props.swatch ? { '--hc': props.swatch } : {}) } as CSSProperties;
  const content = props.kind === 'agent' ? <>
    {props.logo ? <img src={props.logo} alt="" /> : <span className="kh-ini">{props.initials}</span>}
    <span className="kh-own" style={{ '--oh': props.ownerHue, ...(props.ownerSwatch ? { '--hc': props.ownerSwatch } : {}) } as CSSProperties}
      {...(props.ownerHost ? { title: `Running on ${props.ownerHost}` } : {})}>{props.ownerInitials}</span>
    {props.status ? <span className={`kh-st ${props.status}`} /> : null}
  </> : props.initials;

  if (props.static || props.ghost) {
    return <span className={className} style={style} aria-hidden="true" {...(offline ? { title: offline } : {})}>{content}</span>;
  }
  return <button type="button" className={className} style={style} aria-label={offline ? `${props.label} (${offline})` : props.label}
    {...(offline ? { title: offline } : {})} onClick={props.onClick}>{content}</button>;
}
