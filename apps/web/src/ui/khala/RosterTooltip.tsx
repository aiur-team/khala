import { useEffect, useRef, type RefObject } from 'react';
import { placePopover } from './Popover';

/** Card-level tooltips escape the roster's scroll overflow and bottom mask. */
export function RosterTooltip({ card }: Readonly<{ card: RefObject<HTMLElement | null> }>) {
  const tip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = card.current;
    const host = tip.current;
    if (!root || !host) return undefined;
    const hide = () => { host.hidden = true; };
    const show = (event: MouseEvent) => {
      if (!window.matchMedia('(hover: hover)').matches) return;
      const anchor = event.target instanceof Element ? event.target.closest<HTMLElement>('.kh-roster [data-tip]') : null;
      if (!anchor || anchor.closest('[inert]') || anchor.getAttribute('aria-expanded') === 'true') return;
      host.textContent = anchor.dataset.tip ?? '';
      host.hidden = false;
      const { left, top } = placePopover(root.getBoundingClientRect(), anchor.getBoundingClientRect(),
        { width: host.offsetWidth, height: host.offsetHeight });
      host.style.left = `${left}px`;
      host.style.top = `${top}px`;
    };
    root.addEventListener('mouseover', show);
    root.addEventListener('mouseout', hide);
    root.addEventListener('pointerdown', hide);
    root.addEventListener('scroll', hide, true);
    root.addEventListener('keydown', hide);
    window.addEventListener('resize', hide);
    return () => {
      root.removeEventListener('mouseover', show);
      root.removeEventListener('mouseout', hide);
      root.removeEventListener('pointerdown', hide);
      root.removeEventListener('scroll', hide, true);
      root.removeEventListener('keydown', hide);
      window.removeEventListener('resize', hide);
    };
  }, [card]);
  return <div ref={tip} className="kh-roster-tooltip" role="tooltip" hidden />;
}
