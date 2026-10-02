import { describe, expect, it, vi } from 'vitest';
import { bindPopoverDismissal, placePopover } from './Popover';

const card = { left: 100, top: 50, width: 1000, height: 600 };
const pop = { width: 290, height: 200 };
const anchor = (left: number, top: number, width = 34, height = 34) => ({ left, top, width, height });

describe('placePopover', () => {
  it('aligns to the anchor left edge in the left half of the card', () => {
    expect(placePopover(card, anchor(200, 100), pop)).toEqual({ left: 100, top: 90 });
  });

  it('aligns to the anchor right edge in the right half of the card', () => {
    // anchor right = 934 → card-relative 834; minus popover width.
    expect(placePopover(card, anchor(900, 100), pop)).toEqual({ left: 544, top: 90 });
  });

  it('clamps 8px inside the card', () => {
    expect(placePopover(card, anchor(102, 100), pop).left).toBe(8);
    expect(placePopover(card, anchor(1080, 100, 30), pop).left).toBe(1000 - 290 - 8);
    expect(placePopover(card, anchor(560, 100), { width: 600, height: 200 }).left).toBe(1000 - 600 - 8);
  });

  it('flips above the anchor when it would overflow the bottom, never above 8px', () => {
    expect(placePopover(card, anchor(200, 560), pop).top).toBe(560 - 50 - 200 - 6);
    expect(placePopover(card, anchor(200, 150, 34, 380), { width: 290, height: 300 }).top).toBe(8);
  });
});

function harness() {
  const events = new EventTarget();
  const inside = { id: 'inside' };
  const anchorNode = { id: 'anchor' };
  const onClose = vi.fn();
  const focus = vi.fn();
  const unbind = bindPopoverDismissal({
    events,
    popover: { contains: node => node === inside },
    anchor: { contains: node => node === anchorNode, focus },
    onClose,
  });
  const press = (target: object) => {
    const event = new Event('pointerdown');
    Object.defineProperty(event, 'target', { value: target });
    events.dispatchEvent(event);
  };
  const key = (name: string) => {
    const event = new Event('keydown', { cancelable: true });
    Object.defineProperty(event, 'key', { value: name });
    events.dispatchEvent(event);
    return event;
  };
  return { inside, anchorNode, onClose, focus, unbind, press, key };
}

describe('bindPopoverDismissal', () => {
  it('closes on Escape and returns focus to the anchor', () => {
    const { onClose, focus, key } = harness();
    key('Enter');
    expect(onClose).not.toHaveBeenCalled();
    expect(key('Escape').defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
  });

  it('closes on an outside press but not on the popover or its anchor', () => {
    const { inside, anchorNode, onClose, press } = harness();
    press(inside);
    press(anchorNode);
    expect(onClose).not.toHaveBeenCalled();
    press({ id: 'elsewhere' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('stops listening once unbound', () => {
    const { onClose, unbind, press, key } = harness();
    unbind();
    press({ id: 'elsewhere' });
    key('Escape');
    expect(onClose).not.toHaveBeenCalled();
  });
});
