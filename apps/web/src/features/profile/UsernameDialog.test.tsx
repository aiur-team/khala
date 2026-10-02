import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ProfileStoreProvider } from './ProfileProvider';
import { createProfileStore } from './store';
import { UsernameDialog } from './UsernameDialog';
import type { ProfilePort } from './ports';

async function readyStore(username: string | null) {
  const port: ProfilePort = {
    get: vi.fn(async () => ({ kind: 'ok' as const, username, suggestion: 'alice', color: 'teal' as const, initials: null })),
    setUsername: vi.fn(async (name: string) => ({ kind: 'ok' as const, username: name })),
    setColor: async color => ({ kind: 'ok', color }),
    setInitials: async initials => ({ kind: 'ok', initials }),
  };
  const store = createProfileStore(port);
  store.start();
  await vi.waitFor(() => expect(store.getSnapshot().status).toBe('ready'));
  return { store, port };
}

const dialog = (store: ReturnType<typeof createProfileStore>) =>
  renderToStaticMarkup(<ProfileStoreProvider store={store}><UsernameDialog onClose={vi.fn()} /></ProfileStoreProvider>);

describe('UsernameDialog', () => {
  it('is a labelled modal holding the form with the current name, Save and Cancel', async () => {
    const { store } = await readyStore('Kevin');
    const html = dialog(store);
    const labelledBy = html.match(/role="dialog" aria-modal="true" aria-labelledby="([^"]+)"/u)![1];
    expect(html).toContain(`<h2 id="${labelledBy}">Change username</h2>`);
    expect(html).toContain('value="Kevin"');
    expect(html).toMatch(/<button type="button" class="kh-btn">Cancel<\/button><button type="submit" class="kh-btn pri">Save<\/button>/u);
    expect(html).toContain('Agents still named @Kevin-Claude/-Codex are renamed to match.');
  });

  it('starts from the suggestion, with no rename note, when no username is set', async () => {
    const { store } = await readyStore(null);
    const html = dialog(store);
    expect(html).toContain('value="alice"');
    expect(html).not.toContain('are renamed to match');
  });

  it('saves through the profile port, so the cog reads the new name', async () => {
    const { store, port } = await readyStore('Kevin');
    expect(await store.save('Kev')).toEqual({ kind: 'ok', username: 'Kev' });
    expect(port.setUsername).toHaveBeenCalledWith('Kev');
    expect(store.getSnapshot().username).toBe('Kev');
  });
});
