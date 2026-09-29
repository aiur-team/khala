import { useEffect, useRef, type KeyboardEvent } from 'react';
import { CreateChannelScreen } from '../../features/create-channel/CreateChannelScreen';
import type { HumanRouteContext } from './application';

export function CreateChannelDialog({ context, onClose, onOpenRoom, returnFocus }: Readonly<{
  context: HumanRouteContext;
  onClose(): void;
  onOpenRoom(roomId: string): void;
  returnFocus?: () => void;
}>) {
  const dialog = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLInputElement>('input')?.focus();
    return () => { if (returnFocus) returnFocus(); else opener.current?.focus(); };
  }, [returnFocus]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
    if (event.key !== 'Tab') return;
    const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])') ?? [])];
    if (!controls.length) return;
    if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
  }

  return <div className="khala-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label="Create a channel" className="khala-dialog" onKeyDown={onKeyDown}>
      <button type="button" className="khala-dialog__close aiur-shell__icon-button" aria-label="Close" onClick={onClose}>×</button>
      <CreateChannelScreen ports={context} mode="on_demand" onOpenRoom={onOpenRoom} />
    </div>
  </div>;
}
