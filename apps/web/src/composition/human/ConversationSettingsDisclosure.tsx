import { useEffect, useRef, useState } from 'react';
import { RecoveryPanel, type RecoveryPanelProps } from '../../features/recovery/RecoveryPanel';
import { SettingsIcon } from '../../shell/icons';
import './conversation-settings.css';

export interface ConversationSettingsDisclosureProps {
  /** Include owner, session generation, and room so a navigation change drops old authority. */
  scope: string;
  recovery: RecoveryPanelProps;
}

/** Conversation-level actions for the selected room; agent and closure controls live in the title. */
export function ConversationSettingsDisclosure({ scope, recovery }: ConversationSettingsDisclosureProps) {
  const details = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (details.current) details.current.open = false;
    setOpen(false);
  }, [scope]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !details.current?.contains(event.target)) {
        if (details.current) details.current.open = false;
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);

  return (
    <details ref={details} className="conversation-settings" onToggle={event => setOpen(event.currentTarget.open)}
      onKeyDown={event => {
        if (event.key !== 'Escape' || !details.current?.open) return;
        event.preventDefault();
        event.stopPropagation();
        details.current.open = false;
        details.current.querySelector('summary')?.focus();
      }}>
      <summary className="aiur-shell__icon-button" aria-label="Conversation settings" title="Conversation settings">
        <SettingsIcon /><span className="conversation-settings__label">Settings</span>
      </summary>
      {open ? <div className="conversation-settings__popover" aria-label="Conversation settings">
        <RecoveryPanel key={scope} {...recovery} showClosureAction={false} />
      </div> : null}
    </details>
  );
}
