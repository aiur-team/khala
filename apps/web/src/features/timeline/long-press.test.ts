import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLongPress, LONG_PRESS_MS } from './long-press';

describe('createLongPress', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('opens the popover after a ~500 ms hold and swallows the closing click once', () => {
    const press = createLongPress();
    const open = vi.fn();
    press.down(10, 10, open);
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(open).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(open).toHaveBeenCalledOnce();
    expect(press.consumeClick()).toBe(true);
    expect(press.consumeClick()).toBe(false);
  });

  it('does not fire for a tap released early', () => {
    const press = createLongPress();
    const open = vi.fn();
    press.down(0, 0, open);
    vi.advanceTimersByTime(200);
    press.cancel();
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(open).not.toHaveBeenCalled();
    expect(press.consumeClick()).toBe(false);
  });

  it('tolerates jitter but cancels on a scroll or drag', () => {
    const press = createLongPress();
    const open = vi.fn();
    press.down(0, 0, open);
    press.move(4, 4);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(open).toHaveBeenCalledOnce();
    press.down(0, 0, open);
    press.move(0, 30);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(open).toHaveBeenCalledOnce();
  });
});
