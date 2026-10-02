import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import './conversation.css';

export function ParticipantDetail({ name, children, onClose }: Readonly<{ name: string; children?: ReactNode; onClose(): void }>) {
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
    closeRef.current?.focus();
    return () => opener?.focus();
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
  return <aside ref={detailRef} className="conversation-detail" role={overlay ? 'dialog' : 'complementary'}
    aria-modal={overlay ? 'true' : undefined} aria-label="Conversation details" onKeyDown={handleKeyDown}>
    <button ref={closeRef} type="button" onClick={onClose} aria-label="Close details">×</button><h2>{name}</h2>{children}</aside>;
}
