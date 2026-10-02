// Settings → Profile: an avatar preview over the username and colour, with one
// Save that saves only what changed. Focus is trapped while it is open and
// returns to whatever opened it (the cog).

import { checkName, USERNAME_MAX } from '@khala/contracts/m1/names';
import { defaultHumanColor, HUMAN_COLOR_IDS, type HumanColorId } from '@khala/contracts/m1/colors';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { CheckIcon } from '../../ui/khala/icons';
import { HUMAN_PALETTE } from '../../ui/khala/human-colors';
import { initials } from '../../ui/khala/identity';
import { useProfile, type ProfileColorSaveResult, type ProfileValue } from './ProfileProvider';
import { nameErrors, submitUsername } from './UsernameForm';
import './profile.css';

const colorError = 'Couldn\'t save your color. Try again.';
const signedOutError = 'You were signed out. Sign in again.';
const focusable = 'button:not([disabled]), input:not([disabled])';

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

/** The colour's inline error for a failed save, or `null` once it saved. */
export function colorSaveMessage(result: ProfileColorSaveResult): string | null {
  if (result.kind === 'ok') return null;
  return result.code === 'signed_out' ? signedOutError : colorError;
}

type Profile = Readonly<{ username: string | null; color: HumanColorId | null }>;
type Draft = Readonly<{ name: string; color: HumanColorId }>;

/** Which of the draft's fields differ from the saved profile. */
export function profileChanges(draft: Draft, saved: Profile) {
  return { name: draft.name.trim() !== (saved.username ?? ''), color: draft.color !== saved.color };
}

/** Saves only the changed fields, each through its own API; each failure is worded for its own field. */
export async function saveProfile(draft: Draft, saved: Profile, { save, saveColor }: Pick<ProfileValue, 'save' | 'saveColor'>) {
  const changed = profileChanges(draft, saved);
  const [named, colored] = await Promise.all([
    changed.name ? submitUsername(draft.name, save) : null,
    changed.color ? saveColor(draft.color).then(colorSaveMessage) : null,
  ]);
  return { name: named?.kind === 'error' ? named.message : null, color: colored };
}

export function ProfileDialog({ ownerId, onClose }: Readonly<{ ownerId?: string; onClose(): void }>) {
  const { username, suggestion, color, save, saveColor } = useProfile();
  const [name, setName] = useState(username ?? suggestion);
  const [selected, setSelected] = useState(() => initialColor(color, ownerId));
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [colorFailure, setColorFailure] = useState<string | null>(null);
  const headingId = useId();
  const colorLabelId = useId();
  const nameId = useId();
  const nameErrorId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const radios = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLInputElement>('input')?.focus();
    return () => { opener?.focus(); };
  }, []);

  const checked = checkName(name, 'username');
  const changed = profileChanges({ name, color: selected }, { username, color });
  // A rule error only once the name was edited; a save's error until the next edit.
  const nameMessage = checked.ok ? nameError : changed.name ? nameErrors[checked.error] : null;

  function choose(index: number) {
    const id = HUMAN_COLOR_IDS[index];
    if (!id) return;
    setSelected(id);
    setColorFailure(null);
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
    const items = [...(dialog.current?.querySelectorAll<HTMLElement>(focusable) ?? [])].filter(item => item.tabIndex >= 0);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) { event.preventDefault(); return; }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  async function submit() {
    setSaving(true);
    setNameError(null);
    setColorFailure(null);
    const failed = await saveProfile({ name, color: selected }, { username, color }, { save, saveColor });
    setSaving(false);
    setNameError(failed.name);
    setColorFailure(failed.color);
    if (!failed.name && !failed.color) onClose();
  }

  const { solid } = HUMAN_PALETTE[selected];
  const canSave = checked.ok && (changed.name || changed.color) && !saving;
  return <div className="kh-dlg-scrim" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} className="kh-dlg kh-prof" role="dialog" aria-modal="true" aria-labelledby={headingId} onKeyDown={onKeyDown}>
      <h2 id={headingId} className="kh-prof-h">Profile</h2>
      <span className="kh-prof-av" style={{ background: solid }} aria-hidden="true">{initials(name.trim() || suggestion)}</span>
      <form className="kh-prof-form" noValidate onSubmit={event => { event.preventDefault(); if (canSave) void submit(); }}>
        <div className="kh-prof-sec">
          <label className="kh-prof-lbl" htmlFor={nameId}>Username</label>
          <div className="kh-uname-field">
            <span className="kh-uname-at" aria-hidden="true">@</span>
            <input id={nameId} className="kh-txt" aria-invalid={nameMessage ? true : undefined} {...(nameMessage ? { 'aria-describedby': nameErrorId } : {})}
              value={name} maxLength={USERNAME_MAX} autoComplete="nickname" spellCheck={false} autoCapitalize="none"
              onChange={event => { setName(event.target.value); setNameError(null); }} />
          </div>
          {nameMessage ? <p className="kh-uname-err" id={nameErrorId} role="alert">{nameMessage}</p> : null}
        </div>
        {/* #982 adds the Initials field here, between Username and Color. */}
        <div className="kh-prof-sec">
          <span className="kh-prof-lbl" id={colorLabelId}>Color</span>
          <div className="kh-swatches" role="radiogroup" aria-labelledby={colorLabelId} onKeyDown={onRadioKeyDown}>
            {HUMAN_COLOR_IDS.map((id, index) => {
              const { label, solid: fill } = HUMAN_PALETTE[id];
              const on = id === selected;
              return <button key={id} ref={node => { radios.current[index] = node; }} type="button" role="radio" className="kh-swatch"
                aria-checked={on} aria-label={label} title={label} tabIndex={on ? 0 : -1} onClick={() => choose(index)}>
                <span style={{ background: fill }}>{on ? <CheckIcon /> : null}</span>
              </button>;
            })}
          </div>
          {colorFailure ? <p className="kh-uname-err" role="alert">{colorFailure}</p> : null}
        </div>
        <div className="kh-uname-actions">
          <button type="button" className="kh-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="kh-btn pri" disabled={!canSave}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </div>
  </div>;
}
