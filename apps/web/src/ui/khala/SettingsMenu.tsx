// The brand row's settings cog: a menu button (WAI-ARIA menu-button pattern)
// holding Mode, Profile and Log out.

import type { HumanColorId } from '@khala/contracts/m1/colors';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ThemeChoice } from '../../shell/types';
import { GearIcon, LogOutIcon, MoonIcon, SunIcon, UserIcon } from './icons';
import { HUMAN_PALETTE } from './human-colors';
import { Popover } from './Popover';

export type SettingsMenuProps = Readonly<{
  theme: ThemeChoice;
  onThemeChange?(theme: ThemeChoice): void;
  username: string | null;
  color?: HumanColorId | null;
  /** Opens the profile dialog; without it the menu has no Profile item. */
  onEditProfile?(): void;
  /** Without it the menu has no Log out item, e.g. while identity is checked. */
  onSignOut?(): void;
  signingOut?: boolean;
}>;

/** The index a menu key moves focus to among `count` items, or `null` for any other key. */
export function menuFocusTarget(key: string, index: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowDown': return (index + 1) % count;
    case 'ArrowUp': return (index - 1 + count) % count;
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}

/** The item a key on the closed cog opens the menu at, or `null` for a key that does not open it. */
export function openingFocus(key: string): 'first' | 'last' | null {
  if (key === 'ArrowDown') return 'first';
  if (key === 'ArrowUp') return 'last';
  return null;
}

export function SettingsMenu(props: SettingsMenuProps) {
  const cog = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [focusAt, setFocusAt] = useState<'first' | 'last'>('first');
  const close = useCallback(() => setOpen(false), []);
  const items = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];

  useEffect(() => {
    if (!open) return;
    const all = items();
    (focusAt === 'last' ? all[all.length - 1] : all[0])?.focus();
  }, [focusAt, open]);

  function openAt(at: 'first' | 'last') {
    setFocusAt(at);
    setOpen(true);
  }

  /** Closes the menu and returns focus to the cog before `then` runs. */
  function activate(then: () => void) {
    setOpen(false);
    cog.current?.focus();
    then();
  }

  function onCogKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const at = openingFocus(event.key);
    if (!at) return;
    event.preventDefault();
    openAt(at);
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Tab') {
      // Focus the cog and let Tab carry on from it, so the menu closes in place.
      setOpen(false);
      cog.current?.focus();
      return;
    }
    const all = items();
    const next = menuFocusTarget(event.key, all.indexOf(document.activeElement as HTMLButtonElement), all.length);
    if (next === null) return;
    event.preventDefault();
    all[next]?.focus();
  }

  return <>
    <button ref={cog} type="button" className="tool-btn icon-only" aria-label="Settings" title="Settings"
      aria-haspopup="menu" aria-expanded={open} onKeyDown={onCogKeyDown}
      onClick={() => (open ? setOpen(false) : openAt('first'))}><GearIcon /></button>
    <Popover anchor={cog} open={open} onClose={close} menu>
      <div ref={menu} role="menu" aria-label="Settings" onKeyDown={onMenuKeyDown}>
        <SettingsMenuItems items={settingsItems(props)} activate={activate} />
      </div>
    </Popover>
  </>;
}

export type SettingsItem = Readonly<{
  id: string;
  icon: ReactNode;
  label: string;
  /** Secondary text at the item's end, e.g. the current username. */
  detail?: ReactNode;
  disabled?: boolean;
  run(): void;
}>;

/**
 * The menu's items in order. A new item is one more entry here; the keyboard
 * navigation works over however many items there are.
 */
export function settingsItems({ theme, onThemeChange, username, color = null, onEditProfile, onSignOut, signingOut = false }: SettingsMenuProps): SettingsItem[] {
  const next: ThemeChoice = theme === 'dark' ? 'light' : 'dark';
  const items: SettingsItem[] = [{
    id: 'mode', icon: next === 'light' ? <SunIcon /> : <MoonIcon />, label: next === 'light' ? 'Light mode' : 'Dark mode',
    run: () => onThemeChange?.(next),
  }];
  if (onEditProfile) items.push({ id: 'profile', icon: <UserIcon />, label: 'Profile', detail: <>
    {color ? <span className="kh-swatch-dot" style={{ background: HUMAN_PALETTE[color].solid }} /> : null}{username ? `@${username}` : 'Not set'}
  </>, run: onEditProfile });
  if (onSignOut) items.push({ id: 'log-out', icon: <LogOutIcon />, label: 'Log out', disabled: signingOut, run: onSignOut });
  return items;
}

/** One `menuitem` per item; `activate` closes the menu, then runs the item. */
export function SettingsMenuItems({ items, activate }: Readonly<{ items: readonly SettingsItem[]; activate(then: () => void): void }>) {
  return <>{items.map(item => <button key={item.id} type="button" role="menuitem" className="kh-mi" tabIndex={-1}
    disabled={item.disabled} onClick={() => activate(item.run)}>
    {item.icon}{item.label}{item.detail ? <em>{item.detail}</em> : null}
  </button>)}</>;
}
