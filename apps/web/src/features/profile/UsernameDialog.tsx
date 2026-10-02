// Settings → Username: the username form in a modal over the card. Focus is
// trapped while it is open and returns to whatever opened it (the cog).

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useProfile } from './ProfileProvider';
import { UsernameForm } from './UsernameForm';
import './profile.css';

const focusable = 'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function UsernameDialog({ onClose }: Readonly<{ onClose(): void }>) {
  const { username, suggestion } = useProfile();
  // The name the dialog opened with: the note keeps naming it after a save.
  const [old] = useState(username);
  const headingId = useId();
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLInputElement>('input')?.focus();
    return () => { opener?.focus(); };
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
    if (event.key !== 'Tab') return;
    const items = [...(dialog.current?.querySelectorAll<HTMLElement>(focusable) ?? [])];
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) { event.preventDefault(); return; }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  return <div className="kh-dlg-scrim" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} className="kh-dlg" role="dialog" aria-modal="true" aria-labelledby={headingId} onKeyDown={onKeyDown}>
      <h2 id={headingId}>Change username</h2>
      <UsernameForm initial={username ?? suggestion} submitLabel="Save" onSaved={onClose} onCancel={onClose} />
      {old ? <p className="kh-dlg-note">Agents still named @{old}-Claude/-Codex are renamed to match.</p> : null}
    </div>
  </div>;
}
