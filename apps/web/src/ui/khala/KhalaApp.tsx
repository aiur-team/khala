// The edge-to-edge Khala frame (RECREATION-SPEC §1.2): one full-viewport
// `.kh-card` with the list column, the main column, the detail pane and the
// card's single popover and toast hosts.

import { useRef, type ReactNode } from 'react';
import aiurLogo from '../../landing/public/assets/aiur-logo.png';
import type { ThemeChoice } from '../../shell/types';
import { ThemeToggleIcon } from './icons';
import { PopoverHostProvider } from './Popover';
import { Toast, ToastProvider } from './Toast';
import './khala-app.css';

export type KhalaAppProps = Readonly<{
  theme: ThemeChoice;
  onThemeChange?(theme: ThemeChoice): void;
  /** Target of the wordmark. */
  homeHref?: string;
  /** Brand-row actions after the theme toggle, e.g. Log out. */
  brandActions?: ReactNode;
  /** The list column below the brand row; omit it for a single-pane state frame. */
  list?: ReactNode;
  main: ReactNode;
  detail?: ReactNode;
  /** On a phone-width card, show the thread rather than the list (§14). */
  inThread?: boolean;
  /** Shows the "Live" badge while the homeserver sync is live. */
  live?: boolean;
  className?: string;
}>;

function Brand({ theme, onThemeChange, homeHref, live, actions }: Readonly<{
  theme: ThemeChoice;
  onThemeChange: ((theme: ThemeChoice) => void) | undefined;
  homeHref: string;
  live: boolean;
  actions: ReactNode;
}>) {
  return <div className="kh-brand">
    <img className="brand-logo" src={aiurLogo} alt="" />
    <a className="wm" href={homeHref} aria-label="Khala home">khala</a>
    {live ? <span className="status-badge status-badge-live brand-live" role="status"><span className="status-badge-dot" /> Live</span> : null}
    <span className="kh-brand-actions">
      <button type="button" className="tool-btn icon-only" aria-label="Toggle color theme" title="Toggle color theme"
        onClick={() => onThemeChange?.(theme === 'dark' ? 'light' : 'dark')}><ThemeToggleIcon /></button>
      {actions}
    </span>
  </div>;
}

export function KhalaApp({ theme, onThemeChange, homeHref = '/conversations', brandActions, list, main, detail, inThread = false, live = false, className = '' }: KhalaAppProps) {
  const card = useRef<HTMLElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const solo = list === undefined;
  const brand = <Brand theme={theme} onThemeChange={onThemeChange} homeHref={homeHref} live={live} actions={brandActions} />;
  const classes = ['section-card', 'kh-card', detail ? 'has-detail' : '', inThread ? 'in-thread' : '', solo ? 'kh-solo' : '']
    .filter(Boolean).join(' ');
  return <div className={`khala-app${className ? ` ${className}` : ''}`} data-theme={theme}>
    <ToastProvider>
      <PopoverHostProvider host={pop} card={card}>
        <section ref={card} className={classes} id="kh-card">
          {solo ? null : <aside className="kh-list" aria-label="Conversations">{brand}{list}</aside>}
          <div className="kh-main">{solo ? brand : null}{main}<Toast /></div>
          <aside className="kh-detail" aria-label="Participant details">{detail}</aside>
          <div ref={pop} className="kh-pop" hidden />
        </section>
      </PopoverHostProvider>
    </ToastProvider>
  </div>;
}
