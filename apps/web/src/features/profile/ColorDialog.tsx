// Settings → Color: ten swatches in a radio group, a preview of the human's
// own bubble, and Save. Focus is trapped while it is open and returns to
// whatever opened it (the cog).

import { defaultHumanColor, HUMAN_COLOR_IDS, type HumanColorId } from '@khala/contracts/m1/colors';
import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { CheckIcon } from '../../ui/khala/icons';
import { HUMAN_PALETTE } from '../../ui/khala/human-colors';
import { useProfile, type ProfileColorSaveResult } from './ProfileProvider';
import './profile.css';

const saveError = 'Could not save your color. Try again.';
const signedOutError = 'You were signed out. Sign in again.';

/** The swatch a key moves selection to among `count`, or `null` for any other key (WAI-ARIA radio group). */
export function radioTarget(key: string, index: number, count: number): number | null {
  switch (key) {
    case 'ArrowRight': case 'ArrowDown': return (index + 1) % count;
    case 'ArrowLeft': case 'ArrowUp': return (index - 1 + count) % count;
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}

/** The colour the dialog opens at: the saved one, else the owner's default, else blue. */
export function initialColor(color: HumanColorId | null, ownerId: string | undefined): HumanColorId {
  return color ?? (ownerId ? defaultHumanColor(ownerId) : 'blue');
}

/** The alert for a failed save, or `null` once it saved. */
export function colorSaveMessage(result: ProfileColorSaveResult): string | null {
  if (result.kind === 'ok') return null;
  return result.code === 'signed_out' ? signedOutError : saveError;
}

export function ColorDialog({ ownerId, onClose }: Readonly<{ ownerId?: string; onClose(): void }>) {
  const { color, saveColor } = useProfile();
  const [selected, setSelected] = useState(() => initialColor(color, ownerId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const radios = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')?.focus();
    return () => { opener?.focus(); };
  }, []);

  function choose(index: number) {
    const id = HUMAN_COLOR_IDS[index];
    if (!id) return;
    setSelected(id);
    setError(null);
    radios.current[index]?.focus();
  }

  function onRadioKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const next = radioTarget(event.key, HUMAN_COLOR_IDS.indexOf(selected), HUMAN_COLOR_IDS.length);
    if (next === null) return;
    event.preventDefault();
    choose(next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
    if (event.key !== 'Tab') return;
    // Only the selected swatch is in the tab order (roving tabindex).
    const items = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [])].filter(item => item.tabIndex >= 0);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) { event.preventDefault(); return; }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  async function save() {
    setSaving(true);
    setError(null);
    const message = colorSaveMessage(await saveColor(selected));
    setSaving(false);
    if (message) setError(message);
    else onClose();
  }

  const preview = { '--hs': HUMAN_PALETTE[selected].solid } as CSSProperties;
  return <div className="kh-dlg-scrim" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} className="kh-dlg" role="dialog" aria-modal="true" aria-labelledby={headingId} onKeyDown={onKeyDown}>
      <h2 id={headingId}>Choose your color</h2>
      <div className="kh-swatches" role="radiogroup" aria-label="Color" onKeyDown={onRadioKeyDown}>
        {HUMAN_COLOR_IDS.map((id, index) => {
          const { label, solid } = HUMAN_PALETTE[id];
          const checked = id === selected;
          return <button key={id} ref={node => { radios.current[index] = node; }} type="button" role="radio" className="kh-swatch"
            aria-checked={checked} aria-label={label} title={label} tabIndex={checked ? 0 : -1} onClick={() => choose(index)}>
            <span style={{ background: solid }}>{checked ? <CheckIcon /> : null}</span>
          </button>;
        })}
      </div>
      <div className="kh-color-preview">
        <div className="kh-row me"><div className="kh-b" style={preview}>This is how your messages look</div></div>
      </div>
      <p className="kh-dlg-note">If someone in a channel already uses this color, others may see you in a nearby color.</p>
      {error ? <p className="kh-uname-err" role="alert">{error}</p> : null}
      <div className="kh-uname-actions">
        <button type="button" className="kh-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="kh-btn pri" disabled={saving || selected === color}
          onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  </div>;
}
