// The edge-to-edge Khala frame (RECREATION-SPEC §1.2): one full-viewport
// `.kh-card` with the list column, the main column, the detail pane and the
// card's single popover and toast hosts.

import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
  /** A settings menu that ends the brand row in place of the theme toggle. */
  brandMenu?: ReactNode;
  /** The list column below the brand row; omit it for a single-pane state frame. */
  list?: ReactNode;
  main: ReactNode;
  detail?: ReactNode;
  /** On a phone-width card, show the thread rather than the list (§14). */
  inThread?: boolean;
  /** A modal layer over the card (e.g. a dialog), visible in either phone pane. */
  overlay?: ReactNode;
  className?: string;
}>;

type DetailHostValue = Readonly<{ host: HTMLElement | null; setOpen(open: boolean): void }>;

const DetailHostContext = createContext<DetailHostValue | null>(null);

/**
 * The card's `.kh-detail` pane for a screen rendered inside `main`: while
 * `open`, the card shows the pane (`.has-detail`) and the caller portals its
 * content into the returned element. `null` outside `KhalaApp`.
 */
export function useDetailHost(open: boolean): HTMLElement | null {
  const context = useContext(DetailHostContext);
  const setOpen = context?.setOpen;
  useLayoutEffect(() => {
    if (!setOpen) return undefined;
    setOpen(open);
    return () => setOpen(false);
  }, [open, setOpen]);
  return context?.host ?? null;
}

/**
 * The brand row (§1.4): logo, wordmark, then the theme toggle and `actions`;
 * the confirm page reuses it. A `menu` replaces the toggle and comes last.
 */
export function Brand({ theme, onThemeChange, homeHref, actions, menu }: Readonly<{
  theme: ThemeChoice;
  onThemeChange: ((theme: ThemeChoice) => void) | undefined;
  homeHref: string;
  actions?: ReactNode;
  menu?: ReactNode;
}>) {
  return <div className="kh-brand">
    <img className="brand-logo" src={aiurLogo} alt="" />
    <a className="wm" href={homeHref} aria-label="Khala home">khala</a>
    <span className="kh-brand-actions">
      {menu ? null : <button type="button" className="tool-btn icon-only" aria-label="Toggle color theme" title="Toggle color theme"
        onClick={() => onThemeChange?.(theme === 'dark' ? 'light' : 'dark')}><ThemeToggleIcon /></button>}
      {actions}
      {menu}
    </span>
  </div>;
}

export function KhalaApp({ theme, onThemeChange, homeHref = '/conversations', brandActions, brandMenu, list, main, detail, inThread = false, overlay, className = '' }: KhalaAppProps) {
  const card = useRef<HTMLElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [detailHost, setDetailHost] = useState<HTMLElement | null>(null);
  const [hostedDetail, setHostedDetail] = useState(false);
  const detailContext = useMemo(() => ({ host: detailHost, setOpen: setHostedDetail }), [detailHost]);
  const solo = list === undefined;
  const brand = <Brand theme={theme} onThemeChange={onThemeChange} homeHref={homeHref} actions={brandActions} menu={brandMenu} />;
  const classes = ['section-card', 'kh-card', detail || hostedDetail ? 'has-detail' : '', inThread ? 'in-thread' : '', solo ? 'kh-solo' : '']
    .filter(Boolean).join(' ');
  return <div className={`khala-app${className ? ` ${className}` : ''}`} data-theme={theme}>
    <ToastProvider>
      <PopoverHostProvider host={pop} card={card}><DetailHostContext.Provider value={detailContext}>
        <section ref={card} className={classes} id="kh-card">
          {solo ? null : <aside className="kh-list" aria-label="Conversations">{brand}{list}</aside>}
          <main className="kh-main">{solo ? brand : null}{main}<Toast /></main>
          {/* The pane's content (ParticipantDetail) carries its own landmark or dialog role. */}
          <div ref={setDetailHost} className="kh-detail">{detail}</div>
          <div ref={pop} className="kh-pop" hidden />
          {overlay}
        </section>
      </DetailHostContext.Provider></PopoverHostProvider>
    </ToastProvider>
  </div>;
}
