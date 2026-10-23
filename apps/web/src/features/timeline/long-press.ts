// iOS-style press-and-hold. A hold of `LONG_PRESS_MS` without moving fires
// once; a tap, a drag or a scroll never does. After a hold fires, the click
// that ends it is swallowed, so a mention inside the bubble doesn't also open.

export const LONG_PRESS_MS = 500;
/** Movement (px) past which a press is a scroll or drag, not a hold. */
const SLOP_PX = 10;

type Timers = Readonly<{ set(run: () => void, ms: number): unknown; clear(handle: unknown): void }>;

const browserTimers: Timers = { set: (run, ms) => setTimeout(run, ms), clear: handle => clearTimeout(handle as number) };

export type LongPress = Readonly<{
  down(x: number, y: number, fire: () => void): void;
  move(x: number, y: number): void;
  cancel(): void;
  /** True once after a hold fired: the caller drops that click. */
  consumeClick(): boolean;
}>;

export function createLongPress(timers: Timers = browserTimers): LongPress {
  let handle: unknown = null;
  let origin = { x: 0, y: 0 };
  let fired = false;
  const cancel = () => {
    if (handle !== null) timers.clear(handle);
    handle = null;
  };
  return {
    down(x, y, fire) {
      cancel();
      fired = false;
      origin = { x, y };
      handle = timers.set(() => {
        handle = null;
        fired = true;
        fire();
      }, LONG_PRESS_MS);
    },
    move(x, y) {
      if (Math.hypot(x - origin.x, y - origin.y) > SLOP_PX) cancel();
    },
    cancel,
    consumeClick() {
      const was = fired;
      fired = false;
      return was;
    },
  };
}
