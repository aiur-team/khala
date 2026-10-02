// Popovers (RECREATION-SPEC §12.1). The card has exactly one `.kh-pop` host,
// rendered by `KhalaApp`; a `Popover` portals its content into that host,
// places it against the card and closes the previous popover when it opens.

import { createContext, useContext, useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

export type Box = Readonly<{ left: number; top: number; width: number; height: number }>;

/** `khPopPlace` (`source:4434-4441`): card-relative `left`/`top` for a popover of `size`. */
export function placePopover(card: Box, anchor: Box, size: Readonly<{ width: number; height: number }>): { left: number; top: number } {
  const anchorLeft = anchor.left - card.left;
  let left = anchorLeft < card.width / 2 ? anchorLeft : anchor.left + anchor.width - card.left - size.width;
  left = Math.max(8, Math.min(left, card.width - size.width - 8));
  let top = anchor.top + anchor.height - card.top + 6;
  if (top + size.height > card.height - 8) top = Math.max(8, anchor.top - card.top - size.height - 6);
  return { left, top };
}

type Containing = Readonly<{ contains(node: unknown): boolean }>;

/**
 * Closes on Escape (returning focus to the anchor) or on a pointer press
 * outside both the popover and its anchor. The anchor's own click toggles.
 */
export function bindPopoverDismissal({ events, popover, anchor, onClose }: Readonly<{
  events: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  popover: Containing;
  anchor: Containing & Readonly<{ focus(): void }>;
  onClose(): void;
}>): () => void {
  const onKeyDown = (event: Event) => {
    if ((event as KeyboardEvent).key !== 'Escape') return;
    event.preventDefault();
    onClose();
    anchor.focus();
  };
  const onPointerDown = (event: Event) => {
    if (popover.contains(event.target) || anchor.contains(event.target)) return;
    onClose();
  };
  events.addEventListener('keydown', onKeyDown);
  events.addEventListener('pointerdown', onPointerDown);
  return () => {
    events.removeEventListener('keydown', onKeyDown);
    events.removeEventListener('pointerdown', onPointerDown);
  };
}

type PopoverHostValue = Readonly<{
  host: RefObject<HTMLDivElement | null>;
  card: RefObject<HTMLElement | null>;
  /** Closes whichever popover is open, so only one ever is. */
  active: { current: (() => void) | null };
}>;

const PopoverHostContext = createContext<PopoverHostValue | null>(null);

export function PopoverHostProvider({ host, card, children }: Readonly<{
  host: RefObject<HTMLDivElement | null>;
  card: RefObject<HTMLElement | null>;
  children?: ReactNode;
}>) {
  const active = useRef<(() => void) | null>(null);
  return <PopoverHostContext.Provider value={{ host, card, active }}>{children}</PopoverHostContext.Provider>;
}

/**
 * An open popover anchored to `anchor`. The caller owns `open` and clears it
 * in `onClose`; the anchor's `aria-expanded` follows the popover.
 */
export function Popover({ anchor, open, onClose, menu = false, children }: Readonly<{
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose(): void;
  /** The compact menu variant (`.kh-pop.menu`). */
  menu?: boolean;
  children: ReactNode;
}>) {
  const context = useContext(PopoverHostContext);
  if (!context) throw new Error('Popover must render inside KhalaApp');
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useLayoutEffect(() => {
    const host = context.host.current;
    const card = context.card.current;
    const anchorElement = anchor.current;
    if (!open || !host || !card || !anchorElement) return undefined;
    const close = () => closeRef.current();
    if (context.active.current && context.active.current !== close) context.active.current();
    context.active.current = close;

    host.className = `kh-pop${menu ? ' menu' : ''}`;
    host.hidden = false;
    anchorElement.setAttribute('aria-expanded', 'true');
    const place = () => {
      if (!anchorElement.isConnected) return;
      const { left, top } = placePopover(card.getBoundingClientRect(), anchorElement.getBoundingClientRect(),
        { width: host.offsetWidth, height: host.offsetHeight });
      host.style.left = `${left}px`;
      host.style.top = `${top}px`;
    };
    place();
    window.addEventListener('resize', place);
    const unbind = bindPopoverDismissal({ events: document, popover: host, anchor: anchorElement, onClose: close });
    if (window.matchMedia('(hover: hover)').matches) host.querySelector('input')?.focus();
    return () => {
      unbind();
      window.removeEventListener('resize', place);
      anchorElement.setAttribute('aria-expanded', 'false');
      host.hidden = true;
      if (context.active.current === close) context.active.current = null;
    };
  }, [anchor, context, menu, open]);

  const host = context.host.current;
  return open && host ? createPortal(children, host) : null;
}
