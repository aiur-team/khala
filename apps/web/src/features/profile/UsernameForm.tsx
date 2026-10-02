// The username field, shared by first sign-in and Settings: live name rules,
// the save, and a preview of the agent names the username implies.

import { useId, useState } from 'react';
import { checkName, defaultAgentName, USERNAME_MAX, USERNAME_MIN, type NameError } from '@khala/contracts/m1/names';
import { useProfile, type ProfileSaveResult } from './ProfileProvider';
import './profile.css';

const nameErrors: Record<NameError, string> = {
  too_short: `At least ${USERNAME_MIN} characters.`,
  too_long: `At most ${USERNAME_MAX} characters.`,
  invalid_characters: 'Use letters, numbers, . _ or -, starting and ending with a letter or number.',
  reserved: 'That name is reserved.',
};
const takenError = 'That username is taken.';
const saveError = 'Couldn\'t save. Try again.';
const signedOutError = 'You were signed out. Sign in again.';

export type UsernameSubmit = { kind: 'saved'; username: string } | { kind: 'error'; message: string };

/** Saves a valid name and words the outcome; an invalid one never reaches `save`. */
export async function submitUsername(value: string, save: (username: string) => Promise<ProfileSaveResult>): Promise<UsernameSubmit> {
  const checked = checkName(value, 'username');
  if (!checked.ok) return { kind: 'error', message: nameErrors[checked.error] };
  let result: ProfileSaveResult;
  try {
    result = await save(checked.name);
  } catch {
    return { kind: 'error', message: saveError };
  }
  if (result.kind === 'ok') return { kind: 'saved', username: result.username };
  if (result.code === 'username_taken') return { kind: 'error', message: takenError };
  if (result.code === 'invalid_username' && result.reason) return { kind: 'error', message: nameErrors[result.reason] };
  if (result.code === 'signed_out') return { kind: 'error', message: signedOutError };
  return { kind: 'error', message: saveError };
}

export type UsernameFieldsProps = Readonly<{
  value: string;
  submitLabel: string;
  saving: boolean;
  /** The last save's failure, shown until the value changes. */
  error: string | null;
  onChange(value: string): void;
  onSubmit(): void;
  onCancel?(): void;
}>;

/** The controlled form; `UsernameForm` owns its state and the save. */
export function UsernameFields({ value, submitLabel, saving, error, onChange, onSubmit, onCancel }: UsernameFieldsProps) {
  const hintId = useId();
  const errorId = useId();
  const checked = checkName(value, 'username');
  const message = checked.ok ? error : nameErrors[checked.error];
  const name = value.trim();
  return <form className="kh-uname" noValidate onSubmit={event => { event.preventDefault(); if (checked.ok && !saving) onSubmit(); }}>
    <div className="kh-uname-field">
      <span className="kh-uname-at" aria-hidden="true">@</span>
      <input className="kh-txt" aria-label="Username" aria-describedby={message ? `${hintId} ${errorId}` : hintId} aria-invalid={checked.ok ? undefined : true}
        value={value} maxLength={USERNAME_MAX} autoComplete="nickname" spellCheck={false} autoCapitalize="none"
        onChange={event => onChange(event.target.value)} />
    </div>
    <p className="kh-uname-hint" id={hintId}>{USERNAME_MIN}–{USERNAME_MAX} letters, numbers, . _ or -</p>
    {message ? <p className="kh-uname-err" id={errorId} role="alert">{message}</p> : null}
    {name ? <p className="kh-uname-preview">
      Your agents will be named @{defaultAgentName(name, 'claude')} and @{defaultAgentName(name, 'codex')}.
    </p> : null}
    <div className="kh-uname-actions">
      {onCancel ? <button type="button" className="kh-btn" onClick={onCancel}>Cancel</button> : null}
      <button type="submit" className="kh-btn pri" disabled={!checked.ok || saving}>{saving ? 'Saving…' : submitLabel}</button>
    </div>
  </form>;
}

export function UsernameForm({ initial, submitLabel, onSaved, onCancel }: Readonly<{
  initial: string;
  submitLabel: string;
  onSaved(username: string): void;
  onCancel?(): void;
}>) {
  const { save } = useProfile();
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setSaving(true);
    setError(null);
    const result = await submitUsername(value, save);
    setSaving(false);
    if (result.kind === 'saved') onSaved(result.username);
    else setError(result.message);
  }
  return <UsernameFields value={value} submitLabel={submitLabel} saving={saving} error={error}
    onChange={next => { setValue(next); setError(null); }} onSubmit={() => void submit()} {...(onCancel ? { onCancel } : {})} />;
}
