import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { defaultHumanColor, HUMAN_COLOR_IDS, type HumanColorId } from '@khala/contracts/m1/colors';
import { HUMAN_PALETTE } from '../../ui/khala/human-colors';
import { colorSaveMessage, ColorDialog, initialColor, radioTarget } from './ColorDialog';
import { ProfileStoreProvider } from './ProfileProvider';
import { createProfileStore } from './store';
import type { ProfilePort } from './ports';

async function readyStore(color: HumanColorId, setColor: ProfilePort['setColor'] = vi.fn(async (next: HumanColorId) => ({ kind: 'ok' as const, color: next }))) {
  const port: ProfilePort = {
    get: vi.fn(async () => ({ kind: 'ok' as const, username: 'Kevin', suggestion: 'kevin', color })),
    setUsername: vi.fn(async (name: string) => ({ kind: 'ok' as const, username: name })),
    setColor,
  };
  const store = createProfileStore(port);
  store.start();
  await vi.waitFor(() => expect(store.getSnapshot().status).toBe('ready'));
  return { store, port };
}

const dialog = (store: ReturnType<typeof createProfileStore>, ownerId?: string) => renderToStaticMarkup(
  <ProfileStoreProvider store={store}><ColorDialog onClose={vi.fn()} {...(ownerId ? { ownerId } : {})} /></ProfileStoreProvider>);
const radios = (html: string) => [...html.matchAll(/<button type="button" role="radio" class="kh-swatch" aria-checked="(true|false)" aria-label="([^"]+)" title="[^"]+" tabindex="(-?\d)">/gu)]
  .map(([, checked, label, tabIndex]) => ({ checked: checked === 'true', label, tabIndex: Number(tabIndex) }));

describe('ColorDialog', () => {
  it('is a labelled modal with a Color radio group of the ten colours in palette order', async () => {
    const { store } = await readyStore('teal');
    const html = dialog(store);
    const labelledBy = html.match(/role="dialog" aria-modal="true" aria-labelledby="([^"]+)"/u)![1];
    expect(html).toContain(`<h2 id="${labelledBy}">Choose your color</h2>`);
    expect(html).toContain('<div class="kh-swatches" role="radiogroup" aria-label="Color">');
    expect(radios(html).map(radio => radio.label)).toEqual(['Red', 'Orange', 'Amber', 'Lime', 'Green', 'Teal', 'Blue', 'Indigo', 'Purple', 'Pink']);
    expect(radios(html).map(radio => radio.label)).toEqual(HUMAN_COLOR_IDS.map(id => HUMAN_PALETTE[id].label));
    expect(html).toContain('If someone in a channel already uses this color, others may see you in a nearby color.');
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

  it('fills each swatch with its solid colour', async () => {
    const { store } = await readyStore('blue');
    const fills = [...dialog(store).matchAll(/<span style="background:(#[0-9a-f]{6})">/gu)].map(match => match[1]);
    expect(fills).toEqual(HUMAN_COLOR_IDS.map(id => HUMAN_PALETTE[id].solid));
  });

  it('previews an own bubble in the selected colour', async () => {
    const { store } = await readyStore('purple');
    expect(dialog(store)).toContain('<div class="kh-row me"><div class="kh-b" style="--hs:#a03cda">This is how your messages look</div></div>');
  });

  it('disables Save while the selection is the current colour, beside Cancel', async () => {
    const { store } = await readyStore('teal');
    expect(dialog(store)).toMatch(/<button type="button" class="kh-btn">Cancel<\/button><button type="button" class="kh-btn pri" disabled="">Save<\/button>/u);
  });

  it('opens at the owner default, or blue, when no colour is saved; Save is then enabled', () => {
    expect(initialColor('pink', 'owner_alice')).toBe('pink');
    expect(initialColor(null, 'owner_alice')).toBe(defaultHumanColor('owner_alice'));
    expect(initialColor(null, undefined)).toBe('blue');
    const html = renderToStaticMarkup(<ColorDialog onClose={vi.fn()} ownerId="owner_alice" />);
    expect(radios(html).filter(radio => radio.checked).map(radio => radio.label)).toEqual([HUMAN_PALETTE[defaultHumanColor('owner_alice')].label]);
    expect(html).toContain('<button type="button" class="kh-btn pri">Save</button>');
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

  it('saves through ProfilePort.setColor so the cog reads the new colour', async () => {
    const { store, port } = await readyStore('teal');
    const result = await store.saveColor('indigo');
    expect(port.setColor).toHaveBeenCalledWith('indigo');
    expect(colorSaveMessage(result)).toBeNull();
    expect(store.getSnapshot().color).toBe('indigo');
  });

  it('words a failed save, keeping signed-out handling', async () => {
    const { store } = await readyStore('teal', vi.fn(async () => ({ kind: 'error' as const, code: 'unavailable' as const })));
    expect(colorSaveMessage(await store.saveColor('indigo'))).toBe('Could not save your color. Try again.');
    expect(store.getSnapshot().color).toBe('teal');
    expect(colorSaveMessage({ kind: 'error', code: 'signed_out' })).toBe('You were signed out. Sign in again.');
  });
});
