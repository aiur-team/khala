import { type SyntheticEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SendIcon } from '../khala/icons';
import { MentionChips, type MentionTarget } from '../khala/MentionChips';
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
  placeholder = 'Message the Khala', mentionTargets = [], chipsOpen, onChipsOpenChange }: Readonly<{
  value: string; onChange(value: string): void; onSend(): void;
  disabled?: boolean; sendDisabled?: boolean; sendDescriptionId?: string;
  placeholder?: string;
  mentionTargets?: readonly MentionTarget[];
  chipsOpen?: boolean; onChipsOpenChange?(open: boolean): void;
}>) {
  const input = useRef<HTMLTextAreaElement>(null);
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
  const query = disabled ? null : activeMentionQuery(value, caret);
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

  return <>
    <MentionChips targets={mentionTargets} value={value} open={open} onOpenChange={setOpen}
      onChange={next => { onChange(next); setCaret(next.length); input.current?.focus(); }} />
    <form className="kh-comp" onSubmit={event => { event.preventDefault(); onSend(); }}>
      {mentionOpen ? <MentionPopup options={options} active={active} onPick={pick} onHover={setActive} targets={mentionTargets} /> : null}
      <label className="sr-only" htmlFor="kh-input">Message</label>
      <textarea ref={input} className="kh-input" id="kh-input" rows={1} placeholder={placeholder} value={value}
        onChange={event => { onChange(event.target.value); setCaret(event.target.selectionStart); }}
        disabled={disabled} aria-describedby={sendDescriptionId}
        role="combobox" aria-autocomplete="list" aria-expanded={mentionOpen}
        aria-controls={mentionOpen ? MENTION_LIST_ID : undefined}
        aria-activedescendant={mentionOpen ? mentionOptionId(options[active]!) : undefined}
        onSelect={syncCaret} onKeyUp={syncCaret} onClick={syncCaret}
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
          if (!disabled && !sendDisabled && value.trim()) onSend();
        }} />
      <button className="kh-send" type="submit" disabled={disabled || sendDisabled || !value.trim()} aria-describedby={sendDescriptionId} aria-label="Send"><SendIcon /></button>
    </form>
  </>;
}
