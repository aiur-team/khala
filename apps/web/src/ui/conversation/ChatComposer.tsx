import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import './conversation.css';

export function ChatComposer({ value, onChange, onSend, disabled = false, sendDisabled = false, sendDescriptionId, participants }: Readonly<{
  value: string; onChange(value: string): void; onSend(): void; disabled?: boolean; sendDisabled?: boolean; sendDescriptionId?: string; participants?: ReactNode;
}>) {
  const input = useRef<HTMLTextAreaElement>(null);
  const fitDraft = useCallback(() => {
    const textarea = input.current;
    if (!textarea) return;
    textarea.style.height = '38px';
    const needed = textarea.scrollHeight + textarea.offsetHeight - textarea.clientHeight;
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
  return <form className="conversation-composer" onSubmit={event => { event.preventDefault(); onSend(); }}>
    {participants ? <div className="conversation-composer__participants" aria-label="Channel participants">{participants}</div> : null}
    <div className="conversation-composer__entry">
    <label className="sr-only" htmlFor="conversation-draft">Message</label>
    <textarea ref={input} id="conversation-draft" value={value} onChange={event => onChange(event.target.value)} disabled={disabled} rows={1} aria-describedby={sendDescriptionId}
      onKeyDown={event => {
        if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        event.preventDefault();
        if (!disabled && !sendDisabled && value.trim()) onSend();
      }} />
    <button type="submit" disabled={disabled || sendDisabled || !value.trim()} aria-describedby={sendDescriptionId} aria-label="Send message">↑</button>
    </div>
  </form>;
}
