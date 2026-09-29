export function ThemeIcon() {
  return <span className="aiur-shell__theme-icon" aria-hidden="true">
    <svg className="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
    <svg className="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  </span>;
}

export function SettingsIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 2h4l.5 2.2 1.9.8 1.9-1.2 2.8 2.8-1.2 1.9.8 1.9L22 10v4l-2.2.5-.8 1.9 1.2 1.9-2.8 2.8-1.9-1.2-1.9.8L14 22h-4l-.5-2.2-1.9-.8-1.9 1.2-2.8-2.8 1.2-1.9-.8-1.9L2 14v-4l2.2-.5.8-1.9-1.2-1.9 2.8-2.8 1.9 1.2 1.9-.8L10 2Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>;
}
