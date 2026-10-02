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
    hue: number;
    ownerHue: number;
    ownerInitials: string;
    ownerHost?: string;
    /** Harness logo URL; `null` renders the agent's initials instead. */
    logo: string | null;
    initials: string;
  }>
  | Shared & Readonly<{ kind: 'human'; label: string; hue: number; initials: string }>
  | Readonly<{ kind: 'generic' }>
  | Readonly<{ kind: 'more'; count: number }>;

export function Avatar(props: AvatarProps) {
  if (props.kind === 'generic') return <span className="kh-av kh-gen" aria-hidden="true">#</span>;
  if (props.kind === 'more') return <span className="kh-av kh-more">+{props.count}</span>;

  const className = `kh-av${props.kind === 'human' ? ' kh-hav' : ''}${props.ghost ? ' ghost' : ''}`;
  const style = { [props.kind === 'agent' ? '--h' : '--oh']: props.hue } as CSSProperties;
  const content = props.kind === 'agent' ? <>
    {props.logo ? <img src={props.logo} alt="" /> : <span className="kh-ini">{props.initials}</span>}
    <span className="kh-own" style={{ '--oh': props.ownerHue } as CSSProperties}
      {...(props.ownerHost ? { title: `Running on ${props.ownerHost}` } : {})}>{props.ownerInitials}</span>
  </> : props.initials;

  if (props.static || props.ghost) {
    return <span className={className} style={style} aria-hidden="true">{content}</span>;
  }
  return <button type="button" className={className} style={style} aria-label={props.label} onClick={props.onClick}>{content}</button>;
}
