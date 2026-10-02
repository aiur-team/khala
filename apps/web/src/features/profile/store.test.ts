import { describe, expect, it, vi } from 'vitest';
import type { HumanColorId } from '@khala/contracts/m1/colors';
import type { ProfilePort } from './ports';
import { createProfileStore } from './store';

function port(overrides: Partial<ProfilePort> = {}): ProfilePort {
  return {
    get: async () => ({ kind: 'ok', username: 'Kevin', suggestion: 'Kevin', color: 'teal' }),
    setUsername: async username => ({ kind: 'ok', username }),
    setColor: async color => ({ kind: 'ok', color }),
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
