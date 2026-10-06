// The name prompt a channel shows only when the viewer, or one of the viewer's
// agents, shares a name with someone who held it here first. It sets a name for
// this channel only, without blocking interaction with the channel.

import { useEffect, useId, useRef, useState } from 'react';
import { AGENT_NAME_MAX, checkName, USERNAME_MAX, type NameError } from '@khala/contracts/m1/names';
import type { ChannelNamePrompt } from './channel-names';

export type ChannelNameSave = (name: string, signal: AbortSignal) => Promise<{ kind: 'ok' } | { kind: 'error'; message: string }>;

const ruleErrors = (max: number): Record<NameError, string> => ({
  too_short: 'At least 2 characters.',
  too_long: `At most ${max} characters.`,
  invalid_characters: 'Use letters, numbers, . _ or -, starting and ending with a letter or number.',
  reserved: 'Choose a name that does not imply an official role.',
});
export const TAKEN_HERE = 'Someone here already uses that name.';

/** The draft's problem, or `null` when it can be saved. */
export function channelNameError(prompt: Pick<ChannelNamePrompt, 'kind' | 'taken'>, draft: string): string | null {
  const kind = prompt.kind === 'human' ? 'username' : 'agent';
  const checked = checkName(draft, kind);
  if (!checked.ok) return ruleErrors(kind === 'username' ? USERNAME_MAX : AGENT_NAME_MAX)[checked.error];
  const wanted = checked.name.toLowerCase();
  return prompt.taken.some(name => name.trim().toLowerCase() === wanted) ? TAKEN_HERE : null;
}

/** The one-line reason the prompt shows. */
export function channelNameNote(prompt: Pick<ChannelNamePrompt, 'reason' | 'held' | 'name'>): string {
  return prompt.reason === 'numbered'
    ? `${prompt.held} was taken here, so your agent joined as ${prompt.name}.`
    : `Someone here is already ${prompt.held}.`;
}

export function ChannelNameDialog({ prompt, onSave }: Readonly<{ prompt: ChannelNamePrompt; onSave: ChannelNameSave }>) {
  const [draft, setDraft] = useState(prompt.suggestion);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const request = useRef<AbortController | null>(null);
  const headingId = useId();
  const noteId = useId();
  const errorId = useId();
  useEffect(() => {
    return () => request.current?.abort();
  }, []);
  const rule = channelNameError(prompt, draft);
  const message = rule ?? failure;

  async function submit() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setSaving(true);
    setFailure(null);
    const result = await onSave(draft.trim(), controller.signal).catch(() => ({ kind: 'error' as const, message: 'Couldn’t save. Try again.' }));
    if (controller.signal.aborted) return;
    setSaving(false);
    if (result.kind === 'error') setFailure(result.message);
  }

  if (dismissed) return null;

  const human = prompt.kind === 'human';
  return <div className="kh-cname-banner">
    <div className="kh-cname" role="region" aria-labelledby={headingId} aria-describedby={noteId}
      data-kh-name-prompt={prompt.participantId}>
      <h2 id={headingId}>{human ? 'Your name in this channel' : 'Agent name in this channel'}</h2>
      <p id={noteId} className="kh-cname-note">{channelNameNote(prompt)}</p>
      <form className="kh-cname-form" noValidate onSubmit={event => { event.preventDefault(); if (!rule && !saving) void submit(); }}>
        <div className="kh-cname-field">
          <span className="kh-cname-at" aria-hidden="true">@</span>
          <input className="kh-txt" aria-labelledby={headingId} aria-invalid={message ? true : undefined}
            {...(message ? { 'aria-describedby': errorId } : {})} value={draft} maxLength={human ? USERNAME_MAX : AGENT_NAME_MAX}
            autoComplete="off" autoCapitalize="none" spellCheck={false}
            onChange={event => { setDraft(event.target.value); setFailure(null); }} />
        </div>
        {message ? <p className="kh-cname-err" id={errorId} role="alert">{message}</p> : null}
        <div className="kh-cname-actions">
          <button type="button" className="kh-btn" onClick={() => { request.current?.abort(); setDismissed(true); }}>Dismiss</button>
          <button type="submit" className="kh-btn pri" disabled={rule !== null || saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </div>
  </div>;
}
