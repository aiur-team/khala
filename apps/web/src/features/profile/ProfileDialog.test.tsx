import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { defaultHumanColor, HUMAN_COLOR_IDS, type HumanColorId } from '@khala/contracts/m1/colors';
import { HUMAN_PALETTE } from '../../ui/khala/human-colors';
import { colorSaveMessage, initialColor, ProfileDialog, profileChanges, radioTarget, saveProfile } from './ProfileDialog';
import { ProfileStoreProvider } from './ProfileProvider';
import { createProfileStore } from './store';
import type { ProfilePort } from './ports';

async function readyStore(color: HumanColorId, overrides: Partial<ProfilePort> = {}) {
  const port: ProfilePort = {
    get: vi.fn(async () => ({ kind: 'ok' as const, username: 'Kevin', suggestion: 'kevin', color })),
    setUsername: vi.fn(async (name: string) => ({ kind: 'ok' as const, username: name })),
    setColor: vi.fn(async (next: HumanColorId) => ({ kind: 'ok' as const, color: next })),
    ...overrides,
  };
  const store = createProfileStore(port);
  store.start();
  await vi.waitFor(() => expect(store.getSnapshot().status).toBe('ready'));
  return { store, port };
}

const dialog = (store: ReturnType<typeof createProfileStore>) =>
  renderToStaticMarkup(<ProfileStoreProvider store={store}><ProfileDialog onClose={vi.fn()} /></ProfileStoreProvider>);
const radios = (html: string) => [...html.matchAll(/<button type="button" role="radio" class="kh-swatch" aria-checked="(true|false)" aria-label="([^"]+)" title="[^"]+" tabindex="(-?\d)">/gu)]
  .map(([, checked, label, tabIndex]) => ({ checked: checked === 'true', label, tabIndex: Number(tabIndex) }));

describe('ProfileDialog', () => {
  it('is a modal named Profile with the avatar preview, then Username, then the Color radio group', async () => {
    const { store } = await readyStore('teal');
    const html = dialog(store);
    const labelledBy = html.match(/role="dialog" aria-modal="true" aria-labelledby="([^"]+)"/u)![1];
    expect(html).toContain(`<h2 id="${labelledBy}" class="kh-prof-h">Profile</h2>`);
    expect(html).toContain('<span class="kh-prof-av" style="background:#187b7e" aria-hidden="true">KE</span>');
    const inputId = html.match(/<label class="kh-prof-lbl" for="([^"]+)">Username<\/label>/u)![1];
    expect(html).toMatch(new RegExp(`<input id="${inputId}" class="kh-txt"[^>]* value="Kevin"/>`, 'u'));
    const colorId = html.match(/<span class="kh-prof-lbl" id="([^"]+)">Color<\/span>/u)![1];
    expect(html).toContain(`<div class="kh-swatches" role="radiogroup" aria-labelledby="${colorId}">`);
    expect(html.indexOf('kh-prof-av')).toBeLessThan(html.indexOf('Username'));
    expect(html.indexOf('Username')).toBeLessThan(html.indexOf('radiogroup'));
  });

  it('carries no helper text or notes', async () => {
    const { store } = await readyStore('teal');
    const html = dialog(store);
    expect(html).not.toContain('kh-uname-hint');
    expect(html).not.toContain('kh-dlg-note');
    expect(html).not.toContain('role="alert"');
  });

  it('lists the ten colours in palette order, each filled with its solid colour', async () => {
    const { store } = await readyStore('blue');
    const html = dialog(store);
    expect(radios(html).map(radio => radio.label)).toEqual(['Red', 'Orange', 'Amber', 'Lime', 'Green', 'Teal', 'Blue', 'Indigo', 'Purple', 'Pink']);
    expect(radios(html).map(radio => radio.label)).toEqual(HUMAN_COLOR_IDS.map(id => HUMAN_PALETTE[id].label));
    const fills = [...html.matchAll(/<button type="button" role="radio"[^>]*><span style="background:(#[0-9a-f]{6})">/gu)].map(match => match[1]);
    expect(fills).toEqual(HUMAN_COLOR_IDS.map(id => HUMAN_PALETTE[id].solid));
  });

  it('checks only the current colour, marks it with a check icon and keeps only it in the tab order', async () => {
    const { store } = await readyStore('teal');
    const html = dialog(store);
    expect(radios(html).filter(radio => radio.checked).map(radio => radio.label)).toEqual(['Teal']);
    // Roving tabindex: the checked radio is the group's single tab stop.
    expect(radios(html).map(radio => radio.tabIndex)).toEqual([-1, -1, -1, -1, -1, 0, -1, -1, -1, -1]);
    expect(html.match(/<svg/gu)).toHaveLength(1);
    expect(html).toMatch(/aria-label="Teal"[^>]*><span style="background:#187b7e"><svg/u);
  });

  it('has one Save, disabled while nothing changed, beside Cancel', async () => {
    const { store } = await readyStore('teal');
    expect(dialog(store)).toMatch(/<button type="button" class="kh-btn">Cancel<\/button><button type="submit" class="kh-btn pri" disabled="">Save<\/button>/u);
    expect(dialog(store).match(/class="kh-btn pri"/gu)).toHaveLength(1);
  });

  it('opens at the saved colour, else the owner default, else blue', () => {
    expect(initialColor('pink', 'owner_alice')).toBe('pink');
    expect(initialColor(null, 'owner_alice')).toBe(defaultHumanColor('owner_alice'));
    expect(initialColor(null, undefined)).toBe('blue');
    const html = renderToStaticMarkup(<ProfileDialog onClose={vi.fn()} ownerId="owner_alice" />);
    expect(radios(html).filter(radio => radio.checked).map(radio => radio.label)).toEqual([HUMAN_PALETTE[defaultHumanColor('owner_alice')].label]);
  });

  it('moves the selection with arrows (wrapping Pink to Red), Home and End', () => {
    const pink = HUMAN_COLOR_IDS.indexOf('pink');
    expect(radioTarget('ArrowRight', 0, 10)).toBe(1);
    expect(radioTarget('ArrowDown', 0, 10)).toBe(1);
    expect(radioTarget('ArrowRight', pink, 10)).toBe(0);
    expect(radioTarget('ArrowLeft', 0, 10)).toBe(pink);
    expect(radioTarget('ArrowUp', 3, 10)).toBe(2);
    expect(radioTarget('Home', 6, 10)).toBe(0);
    expect(radioTarget('End', 0, 10)).toBe(pink);
    expect(radioTarget(' ', 0, 10)).toBeNull();
    expect(radioTarget('Enter', 0, 10)).toBeNull();
  });

  it('notices which fields changed', () => {
    const saved = { username: 'Kevin', color: 'teal' as const };
    expect(profileChanges({ name: ' Kevin ', color: 'teal' }, saved)).toEqual({ name: false, color: false });
    expect(profileChanges({ name: 'Kev', color: 'teal' }, saved)).toEqual({ name: true, color: false });
    expect(profileChanges({ name: 'Kevin', color: 'pink' }, saved)).toEqual({ name: false, color: true });
  });

  it('saves only the changed fields, each through its own port call', async () => {
    const { store, port } = await readyStore('teal');
    const saved = { username: 'Kevin', color: 'teal' as const };
    expect(await saveProfile({ name: 'Kevin', color: 'indigo' }, saved, store)).toEqual({ name: null, color: null });
    expect(port.setColor).toHaveBeenCalledWith('indigo');
    expect(port.setUsername).not.toHaveBeenCalled();
    expect(store.getSnapshot().color).toBe('indigo');

    expect(await saveProfile({ name: 'Kev', color: 'indigo' }, store.getSnapshot(), store)).toEqual({ name: null, color: null });
    expect(port.setUsername).toHaveBeenCalledWith('Kev');
    expect(port.setColor).toHaveBeenCalledTimes(1);

    expect(await saveProfile({ name: 'Kevin', color: 'pink' }, store.getSnapshot(), store)).toEqual({ name: null, color: null });
    expect(store.getSnapshot()).toMatchObject({ username: 'Kevin', color: 'pink' });
  });

  it('words each field\'s failure on its own, keeping the other field\'s save', async () => {
    const { store } = await readyStore('teal', {
      setColor: vi.fn(async () => ({ kind: 'error' as const, code: 'unavailable' as const })),
      setUsername: vi.fn(async () => ({ kind: 'error' as const, code: 'username_taken' as const })),
    });
    const saved = { username: 'Kevin', color: 'teal' as const };
    expect(await saveProfile({ name: 'taken', color: 'indigo' }, saved, store))
      .toEqual({ name: 'That username is taken.', color: 'Couldn\'t save your color. Try again.' });
    expect(store.getSnapshot()).toMatchObject({ username: 'Kevin', color: 'teal' });

    const { store: colorOnly } = await readyStore('teal', { setColor: vi.fn(async () => ({ kind: 'error' as const, code: 'unavailable' as const })) });
    expect(await saveProfile({ name: 'Kev', color: 'indigo' }, saved, colorOnly)).toEqual({ name: null, color: 'Couldn\'t save your color. Try again.' });
    expect(colorOnly.getSnapshot()).toMatchObject({ username: 'Kev', color: 'teal' });
    expect(colorSaveMessage({ kind: 'error', code: 'signed_out' })).toBe('You were signed out. Sign in again.');
  });
});
