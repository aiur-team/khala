import { describe, expect, it, vi } from 'vitest';
import type { HumanRouteContext } from './application';
import { attachHumanCapabilities, type HumanCapability } from './capabilities';

describe('attachHumanCapabilities', () => {
  it('attaches only ready capabilities and releases them in reverse order', () => {
    const calls: string[] = [];
    const capability = (id: HumanCapability['id'], state: HumanCapability['state']): HumanCapability => ({
      id,
      state,
      attach: vi.fn(() => ({ dispose: () => { calls.push(`dispose:${id}`); } })),
    });
    const review = capability('review', 'ready');
    const controls = capability('controls', 'unavailable');
    const recovery = capability('recovery', 'ready');
    const registered = new Set<() => void>();
    const context = {
      registerDisposer(disposer: () => void) {
        registered.add(disposer);
        return () => {
          if (!registered.delete(disposer)) return;
          disposer();
        };
      },
    } as HumanRouteContext;

    const dispose = attachHumanCapabilities([review, controls, recovery], context);
    expect(review.attach).toHaveBeenCalledWith(context);
    expect(controls.attach).not.toHaveBeenCalled();
    expect(recovery.attach).toHaveBeenCalledWith(context);
    expect(registered.size).toBe(2);

    dispose();
    dispose();
    expect(calls).toEqual(['dispose:recovery', 'dispose:review']);
    expect(registered.size).toBe(0);
  });
});
