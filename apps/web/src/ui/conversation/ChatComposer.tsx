import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SendIcon } from '../khala/icons';
import { MentionChips, type MentionTarget } from '../khala/MentionChips';
import './conversation.css';

export { insertMention, type MentionTarget } from '../khala/MentionChips';

/**
 * The composer (RECREATION-SPEC §10) with the mention chips bar (§9) above it.
 * `chipsOpen` is controllable so the roster can close the chips grid.
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
  return <>
    <MentionChips targets={mentionTargets} value={value} open={open} onOpenChange={setOpen}
      onChange={next => { onChange(next); input.current?.focus(); }} />
    <form className="kh-comp" onSubmit={event => { event.preventDefault(); onSend(); }}>
      <label className="sr-only" htmlFor="kh-input">Message</label>
      <textarea ref={input} className="kh-input" id="kh-input" rows={1} placeholder={placeholder} value={value}
        onChange={event => onChange(event.target.value)} disabled={disabled} aria-describedby={sendDescriptionId}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          event.preventDefault();
          if (!disabled && !sendDisabled && value.trim()) onSend();
        }} />
      <button className="kh-send" type="submit" disabled={disabled || sendDisabled || !value.trim()} aria-describedby={sendDescriptionId} aria-label="Send"><SendIcon /></button>
    </form>
  </>;
}
