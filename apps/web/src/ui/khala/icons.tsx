// Khala icon set (RECREATION-SPEC §18), paths verbatim from the design's `KI`.
// Every icon is decorative: the control that holds it carries the name.

import type { ReactNode } from 'react';

function stroke(paths: ReactNode, width = 2, linejoin = true) {
  return function StrokeIcon() {
    return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width}
      strokeLinecap="round" {...(linejoin ? { strokeLinejoin: 'round' as const } : {})}>{paths}</svg>;
  };
}

function filled(paths: ReactNode) {
  return function FilledIcon() {
    return <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor">{paths}</svg>;
  };
}

export const ShareIcon = stroke(<><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" /></>);
export const GearIcon = stroke(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>);
export const CopyIcon = stroke(<><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>);
export const CheckIcon = stroke(<path d="M20 6 9 17l-5-5" />, 2.6);
export const XIcon = stroke(<path d="M18 6 6 18M6 6l12 12" />, 2.4);
export const KebabIcon = filled(<><circle cx="12" cy="5" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="12" cy="19" r="1.8" /></>);
export const CrownIcon = filled(<path d="M3 7.5 7.5 11 12 4l4.5 7L21 7.5 19 19H5z" />);
export const SteerIcon = stroke(<><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="2.2" /><path d="M3.3 10.5c3 .9 5.6 1.4 6.5 1.5M20.7 10.5c-3 .9-5.6 1.4-6.5 1.5M12 14.2V21" /></>);
export const SyncIcon = stroke(<><path d="M20 11a8 8 0 0 0-14.6-4.5M4 13a8 8 0 0 0 14.6 4.5" /><path d="M5 3v4h4M19 21v-4h-4" /></>);
export const AsyncIcon = stroke(<><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z" /></>);
export const ShieldIcon = stroke(<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />);
export const RestoreIcon = stroke(<><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></>);
export const AgentIcon = stroke(<><rect x="3" y="8" width="13" height="11" rx="3" /><path d="M9.5 4v4M7 13.5h.01M12 13.5h.01M20 4v6M17 7h6" /></>);
export const LeaveIcon = stroke(<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />);
export const TrashIcon = stroke(<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />);
export const LinkIcon = stroke(<><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></>);
export const UserIcon = stroke(<><circle cx="12" cy="8" r="4" /><path d="M5 21a7 7 0 0 1 14 0" /></>);
export const DropletIcon = stroke(<path d="M12 2.7S6 9.3 6 14a6 6 0 0 0 12 0c0-4.7-6-11.3-6-11.3z" />);
export const UserXIcon = stroke(<><circle cx="9" cy="8" r="4" /><path d="M2 21a7 7 0 0 1 14 0M17 8l5 5M22 8l-5 5" /></>);
export const LockIcon = stroke(<><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>);
export const PlusIcon = stroke(<path d="M12 5v14M5 12h14" />, 2.2, false);
export const SearchIcon = stroke(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>, 2, false);
export const ChevronLeftIcon = stroke(<path d="m15 18-6-6 6-6" />, 2.4);
export const ChevronDownIcon = stroke(<path d="m6 9 6 6 6-6" />, 2.4);
export const ChipsToggleIcon = stroke(<path d="m6 15 6-6 6 6" />, 2.6);
export const SendIcon = stroke(<path d="M12 19V5M5 12l7-7 7 7" />, 2.4);
export const SunIcon = stroke(<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>);
export const MoonIcon = stroke(<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />);
export const ChatIcon = stroke(<><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.8-.8L3 21l1.9-5.1A8.4 8.4 0 1 1 21 11.5z" /><path d="M8 10.5h.01M12 10.5h.01M16 10.5h.01" /></>);
export const LogOutIcon = stroke(<><path d="M10 17l5-5-5-5M15 12H3" /><path d="M12 3h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7" /></>);

/** The theme toggle's glyph pair; `.toggle-icon` CSS shows the one for the current theme. */
export function ThemeToggleIcon() {
  return <span className="toggle-icon" aria-hidden="true">
    <svg className="sun" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
    <svg className="moon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  </span>;
}
