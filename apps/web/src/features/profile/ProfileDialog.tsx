// Settings → Profile: the username, the initials beside a live avatar preview,
// and the colour, with one Save that saves only what changed. Focus is trapped
// while it is open and returns to whatever opened it (the cog).

import { checkName, USERNAME_MAX } from '@khala/contracts/m1/names';
import { defaultHumanColor, HUMAN_COLOR_IDS, type HumanColorId } from '@khala/contracts/m1/colors';
import { normalizeInitials } from '@khala/contracts/m1/initials';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { CheckIcon } from '../../ui/khala/icons';
import { HUMAN_PALETTE } from '../../ui/khala/human-colors';
import { initials } from '../../ui/khala/identity';
import { useProfile, type ProfileColorSaveResult, type ProfileInitialsSaveResult, type ProfileValue } from './ProfileProvider';
import { nameErrors, submitUsername } from './UsernameForm';
import './profile.css';

const colorError = 'Couldn\'t save your color. Try again.';
const initialsSaveError = 'Couldn\'t save your initials. Try again.';
/** The initials rule, shown only as the field's error. */
export const initialsRuleError = '2 letters or digits';
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

/** The initials' inline error for a failed save, or `null` once they saved. */
export function initialsSaveMessage(result: ProfileInitialsSaveResult): string | null {
  if (result.kind === 'ok') return null;
  if (result.code === 'invalid_initials') return initialsRuleError;
  return result.code === 'signed_out' ? signedOutError : initialsSaveError;
}

/** Keeps the first two code points, so an emoji counts as one character, as the server counts it. */
export function clampInitials(value: string): string {
  return [...value].slice(0, 2).join('');
}

/** The initials a draft saves: canonical ones, `null` for an empty field (none chosen), or `undefined` while invalid. */
export function draftInitials(draft: string): string | null | undefined {
  const value = draft.trim();
  return value ? normalizeInitials(value) ?? undefined : null;
}

type Profile = Readonly<{ username: string | null; color: HumanColorId | null; initials: string | null }>;
type Draft = Readonly<{ name: string; color: HumanColorId; initials: string }>;

/** Which of the draft's fields differ from the saved profile; invalid initials are not a change. */
export function profileChanges(draft: Draft, saved: Profile) {
  const next = draftInitials(draft.initials);
  return { name: draft.name.trim() !== (saved.username ?? ''), color: draft.color !== saved.color,
    initials: next !== undefined && next !== saved.initials };
}

/** Saves only the changed fields, each through its own API; each failure is worded for its own field. */
export async function saveProfile(draft: Draft, saved: Profile,
  { save, saveColor, saveInitials }: Pick<ProfileValue, 'save' | 'saveColor' | 'saveInitials'>) {
  const changed = profileChanges(draft, saved);
  const [named, colored, initialed] = await Promise.all([
    changed.name ? submitUsername(draft.name, save) : null,
    changed.color ? saveColor(draft.color).then(colorSaveMessage) : null,
    changed.initials ? saveInitials(draftInitials(draft.initials) ?? null).then(initialsSaveMessage) : null,
  ]);
  return { name: named?.kind === 'error' ? named.message : null, color: colored, initials: initialed };
}

export function ProfileDialog({ ownerId, onClose }: Readonly<{ ownerId?: string; onClose(): void }>) {
  const { username, suggestion, color, initials: savedInitials, save, saveColor, saveInitials } = useProfile();
  const [name, setName] = useState(username ?? suggestion);
  const [selected, setSelected] = useState(() => initialColor(color, ownerId));
  const [initialsDraft, setInitialsDraft] = useState(savedInitials ?? '');
  // The rule shows once the field is left (or Save is tried), until the next edit.
  const [initialsLeft, setInitialsLeft] = useState(false);
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [colorFailure, setColorFailure] = useState<string | null>(null);
  const [initialsFailure, setInitialsFailure] = useState<string | null>(null);
  const headingId = useId();
  const colorLabelId = useId();
  const nameId = useId();
  const nameErrorId = useId();
  const initialsId = useId();
  const initialsErrorId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const radios = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLInputElement>('input')?.focus();
    return () => { opener?.focus(); };
  }, []);

  const checked = checkName(name, 'username');
  const draft = { name, color: selected, initials: initialsDraft };
  // A colour shown but never saved is the default the human already has, so it isn't a change.
  const saved = { username, color: initialColor(color, ownerId), initials: savedInitials };
  const changed = profileChanges(draft, saved);
  // A rule error only once the name was edited; a save's error until the next edit.
  const nameMessage = checked.ok ? nameError : changed.name ? nameErrors[checked.error] : null;
  const initialsInvalid = draftInitials(initialsDraft) === undefined;
  const initialsMessage = initialsInvalid && initialsLeft ? initialsRuleError : initialsFailure;
  // An empty field previews the derived initials, quieter, as the default they are.
  const derivedInitials = initials(name.trim() || suggestion);
  const typedInitials = initialsDraft.trim().toLocaleUpperCase('en-US');

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
    setInitialsFailure(null);
    const failed = await saveProfile(draft, saved, { save, saveColor, saveInitials });
    setSaving(false);
    setNameError(failed.name);
    setColorFailure(failed.color);
    setInitialsFailure(failed.initials);
    if (!failed.name && !failed.color && !failed.initials) onClose();
  }

  const { solid } = HUMAN_PALETTE[selected];
  const canSave = checked.ok && !initialsInvalid && (changed.name || changed.color || changed.initials) && !saving;
  return <div className="kh-dlg-scrim" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} className="kh-dlg kh-prof" role="dialog" aria-modal="true" aria-labelledby={headingId} onKeyDown={onKeyDown}>
      <h2 id={headingId} className="kh-prof-h">Profile</h2>
      <form className="kh-prof-form" noValidate onSubmit={event => { event.preventDefault(); setInitialsLeft(true); if (canSave) void submit(); }}>
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
        <div className="kh-prof-ini">
          <span className={`kh-prof-av${typedInitials ? '' : ' is-default'}`} style={{ background: solid }} aria-hidden="true">
            <span>{typedInitials || derivedInitials}</span>
          </span>
          <div className="kh-prof-sec">
            <label className="kh-prof-lbl" htmlFor={initialsId}>Initials</label>
            <input id={initialsId} className="kh-txt kh-prof-ini-in" aria-label="Initials" aria-invalid={initialsMessage ? true : undefined}
              {...(initialsMessage ? { 'aria-describedby': initialsErrorId } : {})} value={initialsDraft} placeholder={derivedInitials}
              autoComplete="off" autoCapitalize="characters" spellCheck={false}
              onChange={event => { setInitialsDraft(clampInitials(event.target.value)); setInitialsLeft(false); setInitialsFailure(null); }}
              // Enter is a Save attempt even while invalid initials keep Save disabled.
              onBlur={() => setInitialsLeft(true)} onKeyDown={event => { if (event.key === 'Enter') setInitialsLeft(true); }} />
            {initialsMessage ? <p className="kh-uname-err" id={initialsErrorId} role="alert">{initialsMessage}</p> : null}
          </div>
        </div>
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
