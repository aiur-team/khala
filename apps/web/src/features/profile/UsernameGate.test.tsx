import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ProfileStoreProvider } from './ProfileProvider';
import type { ProfilePort } from './ports';
import { createProfileStore, type ProfileStore } from './store';
import { UsernameGate } from './UsernameGate';

function port(username: string | null, overrides: Partial<ProfilePort> = {}): ProfilePort {
  return {
    get: vi.fn(async () => ({ kind: 'ok' as const, username, suggestion: 'kevin42' })),
    setUsername: vi.fn(async (name: string) => ({ kind: 'ok' as const, username: name })),
    ...overrides,
  };
}
async function loaded(profile: ProfilePort | undefined) {
  const store = createProfileStore(profile);
  store.start();
  await vi.waitFor(() => expect(store.getSnapshot().status).not.toBe('loading'));
  return store;
}
const render = (store: ProfileStore) => renderToStaticMarkup(<ProfileStoreProvider store={store}>
  <UsernameGate theme="dark" pending={<p>Signing in…</p>}><p>The app</p></UsernameGate>
</ProfileStoreProvider>);

describe('UsernameGate', () => {
  it('holds a human without a username on the setup screen', async () => {
    const html = render(await loaded(port(null)));
    expect(html).toContain('>Choose your username</h1>');
    expect(html).toContain('value="kevin42"');
    expect(html).toContain('This is how people and agents mention you in Khala. You can change it later in Settings.');
    expect(html).not.toContain('The app');
  });

  it('lets the human in once the username is saved', async () => {
    const store = await loaded(port(null));
    expect(await store.save('Kevin')).toEqual({ kind: 'ok', username: 'Kevin' });
    const html = render(store);
    expect(html).toContain('The app');
    expect(html).not.toContain('Choose your username');
  });

  it('keeps the setup screen when the save fails', async () => {
    const store = await loaded(port(null, { setUsername: async () => ({ kind: 'error', code: 'username_taken' }) }));
    await store.save('Kevin');
    expect(render(store)).toContain('Choose your username');
  });

  it('lets a human with a username straight in', async () => {
    const html = render(await loaded(port('Kevin')));
    expect(html).toContain('The app');
    expect(html).not.toContain('Choose your username');
  });

  it('shows the pending frame while the profile loads', () => {
    const store = createProfileStore(port(null, { get: () => new Promise(() => undefined) }));
    store.start();
    expect(render(store)).toContain('Signing in…');
    expect(render(store)).not.toContain('The app');
  });

  it('fails open without a profile port or when the load fails', async () => {
    expect(render(await loaded(undefined))).toContain('The app');
    expect(render(await loaded(port(null, { get: async () => ({ kind: 'error', code: 'unavailable' }) })))).toContain('The app');
    expect(render(await loaded(port(null, { get: async () => { throw new Error('offline'); } })))).toContain('The app');
  });

  it('loads again on retry after a failure', async () => {
    let calls = 0;
    const store = await loaded(port(null, { get: async () => (++calls === 1
      ? { kind: 'error', code: 'unavailable' } : { kind: 'ok', username: null, suggestion: 'kevin42' }) }));
    store.retry();
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe('ready'));
    expect(render(store)).toContain('Choose your username');
  });
});
