import { describe, expect, it, vi } from 'vitest';
import { productionSubscriptionSource } from './subscription';

describe('hosted subscription diagnostics', () => {
  it('distinguishes owner-mailbox guard failure before Matrix authorization', async () => {
    const diagnostic = vi.fn();
    const authorize = vi.fn(async () => 'ok' as const);
    const source = productionSubscriptionSource({
      guard: async () => ({ kind: 'unavailable', stage: 'mailbox_guard' }),
      matrix: { source: { authorize, listen: () => () => undefined,
        read: async () => ({ kind: 'unavailable' as const }) } }, diagnostic,
    });
    expect(await source.authorize()).toBe('unavailable');
    expect(authorize).not.toHaveBeenCalled();
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({ stage: 'mailbox_guard', result: 'unavailable' });
  });

  it('distinguishes Matrix source outages after owner authority passes', async () => {
    const diagnostics: unknown[] = [];
    const source = productionSubscriptionSource({
      guard: async () => ({ kind: 'active' }),
      matrix: { source: { authorize: async () => 'unavailable' as const, listen: () => () => undefined,
        read: async () => ({ kind: 'unavailable' as const }) } },
      diagnostic: event => diagnostics.push(event),
    });
    expect(await source.authorize()).toBe('unavailable');
    expect(await source.read({ cursor: null, limit: 50 })).toEqual({ kind: 'unavailable' });
    expect(diagnostics).toEqual([
      { stage: 'matrix_authorize', result: 'unavailable' },
      { stage: 'matrix_read', result: 'unavailable' },
    ]);
  });
});
