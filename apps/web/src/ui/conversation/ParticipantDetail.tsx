import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import '../khala/detail.css';

/**
 * The detail pane frame (RECREATION-SPEC §11): `.kh-d-in` with the kind label
 * and close button. Above 1100px it is a non-modal `complementary` region; at
 * 1100px and below it overlays the thread as a modal dialog that traps focus
 * and returns it to the opener on close.
 */
export function ParticipantDetail({ name, kind, children, onClose }: Readonly<{
  /** The pane's accessible name. */
  name: string;
  /** `.kh-d-lbl` above the hero, e.g. `Agent` or `Human`. */
  kind?: string;
  children?: ReactNode;
  onClose(): void;
}>) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const [overlay, setOverlay] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 1100px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1100px)');
    const update = () => setOverlay(media.matches);
    media.addEventListener('change', update);
    update();
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!overlay) return undefined;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // A pane opened through `useDetailHost` stays `visibility: hidden` until the
    // card's `.has-detail` commits, which refuses focus; focus on the next frame.
    const frame = requestAnimationFrame(() => closeRef.current?.focus());
    return () => { cancelAnimationFrame(frame); opener?.focus(); };
  }, [overlay]);
  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (!overlay) return;
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...(detailRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])];
    if (focusable.length === 0) { event.preventDefault(); closeRef.current?.focus(); return; }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  return <aside ref={detailRef} className="kh-d-in" role={overlay ? 'dialog' : 'complementary'}
    aria-modal={overlay ? 'true' : undefined} aria-label={name} onKeyDown={handleKeyDown}>
    <div className="kh-d-top"><span className="kh-d-lbl">{kind}</span>
      <button ref={closeRef} type="button" className="kh-d-x" onClick={onClose} aria-label="Close details">×</button></div>
    {children}
  </aside>;
}
