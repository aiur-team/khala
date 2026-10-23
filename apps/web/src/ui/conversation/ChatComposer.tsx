import { type SyntheticEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { detectSecret } from '@khala/contracts/m1/secrets';
import { PlusIcon, SendIcon, XIcon } from '../khala/icons';
import { insertMentionAt, MentionChips, type MentionTarget } from '../khala/MentionChips';
import { MENTION_LIST_ID, MentionPopup, mentionOptionId } from '../khala/MentionPopup';
import { activeMentionQuery, applyMention, filterMentionTargets } from '../khala/mention-autocomplete';
import './conversation.css';

export { insertMention, type MentionTarget } from '../khala/MentionChips';

/**
 * The composer (RECREATION-SPEC §10) with the mention chips bar (§9) above it.
 * `chipsOpen` is controllable so the roster can close the chips grid. Typing
 * `@` at a word boundary opens the mention suggestions above the form.
 */
export function ChatComposer({ value, onChange, onSend, disabled = false, sendDisabled = false, sendDescriptionId,
  placeholder = 'Message the Khala', mentionTargets = [], chipsOpen, onChipsOpenChange, onAttach, attachment = null, onRemoveAttachment, attachError = null }: Readonly<{
  value: string; onChange(value: string): void; onSend(): void;
  disabled?: boolean; sendDisabled?: boolean; sendDescriptionId?: string;
  placeholder?: string;
  mentionTargets?: readonly MentionTarget[];
  chipsOpen?: boolean; onChipsOpenChange?(open: boolean): void;
  /** Shows the "+" image button; called with a picked or pasted file. */
  onAttach?(file: File): void;
  /** The image waiting to send: a preview URL and its name. The draft becomes its caption. */
  attachment?: Readonly<{ url: string; name: string }> | null;
  onRemoveAttachment?(): void;
  attachError?: string | null;
}>) {
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  // E2EE: the server cannot see the draft, so the composer refuses secrets itself.
  const secret = detectSecret(value);
  const blocked = disabled || sendDisabled || secret !== null || (!value.trim() && !attachment);
  const [localChipsOpen, setLocalChipsOpen] = useState(false);
  const open = chipsOpen ?? localChipsOpen;
  const setOpen = (next: boolean) => {
    if (chipsOpen === undefined) setLocalChipsOpen(next);
    onChipsOpenChange?.(next);
  };
  const fitDraft = useCallback(() => {
    const textarea = input.current;
    if (!textarea) return;
    textarea.style.height = '38px';
    // One §10 line (.92rem × 1.4 plus padding) overflows 38px by a subpixel; keep 38.
    const overflow = textarea.scrollHeight - textarea.clientHeight;
    const needed = overflow <= 1 ? 38 : textarea.scrollHeight + textarea.offsetHeight - textarea.clientHeight;
    textarea.style.height = `${Math.max(38, Math.min(needed, 140))}px`;
    textarea.style.overflowY = needed > 140 ? 'auto' : 'hidden';
  }, []);
  useLayoutEffect(() => { fitDraft(); }, [fitDraft, value]);
  useEffect(() => {
    const textarea = input.current;
    if (!textarea || typeof ResizeObserver === 'undefined') return;
    let width = textarea.clientWidth;
    const observer = new ResizeObserver(() => {
      if (textarea.clientWidth === width) return;
      width = textarea.clientWidth;
      fitDraft();
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [fitDraft]);

  // Mention autocomplete. The caret starts at the end of the draft the
  // composer mounts with; Esc or blur dismisses the `@` at `dismissedAt`
  // until the caret leaves it.
  const [caret, setCaret] = useState(value.length);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  // With no one to mention (the landing showcase) the draft stays a plain textbox.
  const mentionable = filterMentionTargets(mentionTargets, '').length > 0;
  const query = disabled || !mentionable ? null : activeMentionQuery(value, caret);
  if (query === null && dismissedAt !== null) setDismissedAt(null);
  const options = query ? filterMentionTargets(mentionTargets, query.query) : [];
  const mentionOpen = query !== null && options.length > 0 && query.start !== dismissedAt;
  // The highlight belongs to one query; a changed query starts back at the top.
  const queryKey = query ? `${query.start}:${query.query}` : '';
  const [highlight, setHighlight] = useState({ key: '', index: 0 });
  const active = highlight.key === queryKey ? Math.min(highlight.index, options.length - 1) : 0;
  const setActive = (index: number) => setHighlight({ key: queryKey, index });
  const syncCaret = (event: SyntheticEvent<HTMLTextAreaElement>) => setCaret(event.currentTarget.selectionStart);
  // A pick moves the caret once the new draft is in the textarea, before the
  // next keystroke can land: a later frame would drag typing back to it.
  const pickedCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const textarea = input.current;
    if (pickedCaret.current === null || !textarea) return;
    textarea.setSelectionRange(pickedCaret.current, pickedCaret.current);
    textarea.focus();
    pickedCaret.current = null;
  }, [value]);
  const pick = (target: MentionTarget) => {
    if (!query) return;
    const next = applyMention(value, query, target.label);
    pickedCaret.current = next.caret;
    onChange(next.value);
    setCaret(next.caret);
  };
  // A chip inserts at the draft's caret or over its selection. A blurred
  // textarea keeps both (iOS blurs it on the tap), so read them here.
  const pickChip = (target: MentionTarget) => {
    const textarea = input.current;
    const next = insertMentionAt(value, target.label, textarea?.selectionStart ?? value.length, textarea?.selectionEnd ?? value.length);
    pickedCaret.current = next.caret;
    textarea?.focus(); // inside the tap, so iOS keeps the keyboard up
    onChange(next.value);
    setCaret(next.caret);
  };

  return <>
    {secret ? <p className="kh-secret-warning" role="alert">This message looks like it contains a secret ({secret}). Remove it to send.</p> : null}
    {attachError ? <p className="kh-secret-warning" role="alert">{attachError}</p> : null}
    <MentionChips targets={mentionTargets} open={open} onOpenChange={setOpen} onPick={pickChip} />
    {attachment ? <div className="kh-attach-chip">
      <img src={attachment.url} alt="" />
      <span dir="auto">{attachment.name}</span>
      <button type="button" className="kh-ib sm" aria-label="Remove image" onClick={onRemoveAttachment}><XIcon /></button>
    </div> : null}
    <form className="kh-comp" onSubmit={event => { event.preventDefault(); if (!blocked) onSend(); }}>
      {mentionOpen ? <MentionPopup options={options} active={active} onPick={pick} onHover={setActive} targets={mentionTargets} /> : null}
      {onAttach ? <>
        {/* image/* lets iOS offer Photo Library, Take Photo and Files, and hands HEIC over as JPEG. */}
        <input ref={picker} type="file" accept="image/*" hidden aria-hidden="true" tabIndex={-1} onChange={event => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) onAttach(file);
        }} />
        <button type="button" className="kh-attach" aria-label="Add image" disabled={disabled} onClick={() => picker.current?.click()}><PlusIcon /></button>
      </> : null}
      <label className="sr-only" htmlFor="kh-input">Message</label>
      <textarea ref={input} className="kh-input" id="kh-input" rows={1} placeholder={attachment ? 'Add a caption' : placeholder} value={value}
        onChange={event => { onChange(event.target.value); setCaret(event.target.selectionStart); }}
        disabled={disabled} aria-describedby={sendDescriptionId}
        role={mentionable ? 'combobox' : undefined} aria-autocomplete={mentionable ? 'list' : undefined}
        aria-expanded={mentionable ? mentionOpen : undefined}
        aria-controls={mentionOpen ? MENTION_LIST_ID : undefined}
        aria-activedescendant={mentionOpen ? mentionOptionId(options[active]!) : undefined}
        onSelect={syncCaret} onKeyUp={syncCaret} onClick={syncCaret}
        onPaste={event => {
          const file = onAttach ? [...event.clipboardData.files].find(item => item.type.startsWith('image/')) : undefined;
          if (!file) return;
          event.preventDefault();
          onAttach!(file);
        }}
        onBlur={() => setDismissedAt(query?.start ?? null)}
        onKeyDown={event => {
          const composing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
          if (mentionOpen && query && !composing) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
              return;
            }
            if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
              event.preventDefault();
              pick(options[active]!);
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setDismissedAt(query.start);
              return;
            }
          }
          if (event.key !== 'Enter' || event.shiftKey || composing) return;
          event.preventDefault();
          if (!blocked) onSend();
        }} />
      <button className="kh-send" type="submit" disabled={blocked} aria-describedby={sendDescriptionId} aria-label="Send"><SendIcon /></button>
    </form>
  </>;
}
