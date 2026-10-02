import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { KhalaApp } from './KhalaApp';
import { menuFocusTarget, openingFocus, SettingsMenu, SettingsMenuItems, settingsItems, type SettingsMenuProps } from './SettingsMenu';

const base: SettingsMenuProps = { theme: 'dark', username: 'Kevin', onEditUsername: vi.fn(), onSignOut: vi.fn() };

function cog(props: Partial<SettingsMenuProps> = {}) {
  const html = renderToStaticMarkup(<KhalaApp theme="dark" main={null} brandMenu={<SettingsMenu {...base} {...props} />} />);
  return html.slice(html.indexOf('<span class="kh-brand-actions">'));
}

/** The built items, and their rendered markup. */
function items(props: Partial<SettingsMenuProps> = {}) {
  const built = settingsItems({ ...base, ...props });
  return { built, html: renderToStaticMarkup(<SettingsMenuItems items={built} activate={vi.fn()} />) };
}
const labels = (html: string) => [...html.matchAll(/role="menuitem"[^>]*>(?:<svg.*?<\/svg>)?(.*?)<\/button>/gu)].map(match => match[1]);

describe('SettingsMenu', () => {
  it('renders a closed menu button labelled Settings', () => {
    const html = cog();
    expect(html).toContain('<button type="button" class="tool-btn icon-only" aria-label="Settings" title="Settings" '
      + 'aria-haspopup="menu" aria-expanded="false">');
    expect(html).not.toContain('role="menu"');
  });

  it('lists Mode, Username and Log out in order', () => {
    expect(labels(items().html)).toEqual(['Light mode', 'Username<em>@Kevin</em>', 'Log out']);
    expect(items().built.map(item => item.id)).toEqual(['mode', 'username', 'log-out']);
    expect(labels(items({ theme: 'light' }).html)[0]).toBe('Dark mode');
    expect(labels(items({ username: null }).html)[1]).toBe('Username<em>Not set</em>');
  });

  it('omits Username without onEditUsername and Log out without onSignOut', () => {
    expect(settingsItems({ theme: 'dark', username: 'Kevin' }).map(item => item.label)).toEqual(['Light mode']);
  });

  it('switches to the other theme from Mode', () => {
    const onThemeChange = vi.fn();
    items({ onThemeChange }).built[0]!.run();
    expect(onThemeChange).toHaveBeenCalledWith('light');
    items({ theme: 'light', onThemeChange }).built[0]!.run();
    expect(onThemeChange).toHaveBeenLastCalledWith('dark');
  });

  it('opens the username editor from Username', () => {
    const onEditUsername = vi.fn();
    items({ onEditUsername }).built[1]!.run();
    expect(onEditUsername).toHaveBeenCalledTimes(1);
  });

  it('signs out from Log out, which is disabled while signing out', () => {
    const onSignOut = vi.fn();
    const { built } = items({ onSignOut });
    built[2]!.run();
    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(built[2]!.disabled).toBe(false);
    const signingOut = items({ signingOut: true });
    expect(signingOut.built[2]!.disabled).toBe(true);
    expect(signingOut.html).toContain('<button type="button" role="menuitem" class="kh-mi" tabindex="-1" disabled="">');
  });

  it('renders one menuitem per item, however many there are', () => {
    const four = ['a', 'b', 'c', 'd'].map(id => ({ id, icon: null, label: id.toUpperCase(), run: vi.fn() }));
    expect(labels(renderToStaticMarkup(<SettingsMenuItems items={four} activate={vi.fn()} />))).toEqual(['A', 'B', 'C', 'D']);
  });

  it('opens at the first item on ArrowDown and the last on ArrowUp', () => {
    expect(openingFocus('ArrowDown')).toBe('first');
    expect(openingFocus('ArrowUp')).toBe('last');
    // Enter and Space open through the button's click, which also starts at the first item.
    expect(openingFocus('Enter')).toBeNull();
    expect(openingFocus('a')).toBeNull();
  });

  it('moves focus with wrap-around, Home and End, over any number of items', () => {
    expect(menuFocusTarget('ArrowDown', 0, 3)).toBe(1);
    expect(menuFocusTarget('ArrowDown', 2, 3)).toBe(0);
    expect(menuFocusTarget('ArrowUp', 0, 3)).toBe(2);
    expect(menuFocusTarget('ArrowUp', 2, 3)).toBe(1);
    expect(menuFocusTarget('Home', 2, 3)).toBe(0);
    expect(menuFocusTarget('End', 0, 3)).toBe(2);
    expect(menuFocusTarget('ArrowDown', 3, 5)).toBe(4);
    expect(menuFocusTarget('ArrowDown', 4, 5)).toBe(0);
    expect(menuFocusTarget('End', 0, 5)).toBe(4);
    // Focus outside the items (index -1) enters at the first item on ArrowDown.
    expect(menuFocusTarget('ArrowDown', -1, 3)).toBe(0);
    expect(menuFocusTarget('Enter', 0, 3)).toBeNull();
    expect(menuFocusTarget('ArrowDown', 0, 0)).toBeNull();
  });
});
