import { describe, expect, it, vi } from 'vitest';
import type { HumanColorId } from '@khala/contracts/m1/colors';
import type { ProfilePort } from './ports';
import { createProfileStore } from './store';

function port(overrides: Partial<ProfilePort> = {}): ProfilePort {
  return {
    get: async () => ({ kind: 'ok', username: 'Kevin', suggestion: 'Kevin', color: 'teal', initials: null }),
    setUsername: async username => ({ kind: 'ok', username }),
    setColor: async color => ({ kind: 'ok', color }),
    setInitials: async initials => ({ kind: 'ok', initials }),
    ...overrides,
  };
}
describe('profile colors', () => {
  it('loads the color and updates it after a successful save', async () => {
    const setColor = vi.fn(async (color: HumanColorId) => ({ kind: 'ok' as const, color }));
    const store = createProfileStore(port({ setColor }));
    expect(store.getSnapshot().color).toBeNull();
    store.start();
    await vi.waitFor(() => expect(store.getSnapshot().color).toBe('teal'));
    expect(await store.saveColor('pink')).toEqual({ kind: 'ok', color: 'pink' });
    expect(setColor).toHaveBeenCalledWith('pink');
    expect(store.getSnapshot()).toMatchObject({ color: 'pink', username: 'Kevin' });
  });
  it.each(['error', 'throw'] as const)('preserves the color when save returns %s', async failure => {
    const store = createProfileStore(port({ setColor: async () => {
      if (failure === 'throw') throw new Error('offline');
      return { kind: 'error', code: 'invalid_color' };
    } }));
    store.start();
    await vi.waitFor(() => expect(store.getSnapshot().color).toBe('teal'));
    expect(await store.saveColor('pink')).toEqual({ kind: 'error', code: failure === 'throw' ? 'unavailable' : 'invalid_color' });
    expect(store.getSnapshot().color).toBe('teal');
  });
  it('returns unavailable without a port', async () => {
    expect(await createProfileStore(undefined).saveColor('pink')).toEqual({ kind: 'error', code: 'unavailable' });
  });
});


describe('profile initials', () => {
  it('loads chosen initials and updates and clears them after successful saves', async () => {
    const setInitials = vi.fn(async (initials: string | null) => ({ kind: 'ok' as const, initials }));
    const store = createProfileStore(port({
      get: async () => ({ kind: 'ok', username: 'Kevin', suggestion: 'Kevin', color: 'teal', initials: 'KA' }),
      setInitials,
    }));
    expect(store.getSnapshot().initials).toBeNull();
    store.start();
    await vi.waitFor(() => expect(store.getSnapshot().initials).toBe('KA'));
    expect(await store.saveInitials('KW')).toEqual({ kind: 'ok', initials: 'KW' });
    expect(setInitials).toHaveBeenCalledWith('KW');
    expect(store.getSnapshot()).toMatchObject({ initials: 'KW', username: 'Kevin', color: 'teal' });
    expect(await store.saveInitials(null)).toEqual({ kind: 'ok', initials: null });
    expect(setInitials).toHaveBeenCalledWith(null);
    expect(store.getSnapshot().initials).toBeNull();
  });
  it.each(['error', 'throw'] as const)('preserves the snapshot when initials save returns %s', async failure => {
    const store = createProfileStore(port({ setInitials: async () => {
      if (failure === 'throw') throw new Error('offline');
      return { kind: 'error', code: 'invalid_initials' };
    } }));
    store.start();
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe('ready'));
    const before = store.getSnapshot();
    expect(await store.saveInitials('KW')).toEqual({ kind: 'error', code: failure === 'throw' ? 'unavailable' : 'invalid_initials' });
    expect(store.getSnapshot()).toBe(before);
  });
  it('returns unavailable without a port', async () => {
    expect(await createProfileStore(undefined).saveInitials('KW')).toEqual({ kind: 'error', code: 'unavailable' });
  });
});
