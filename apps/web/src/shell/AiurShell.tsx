import type { AiurShellProps } from './types';

export function AiurShell({ mode, navigation, actions, theme, collapsed, onCollapsedChange, children }: AiurShellProps) {
  if (mode === 'hosted-content') {
    return (
      <div className="khala-content-root" data-theme={theme.theme}>
        {children}
      </div>
    );
  }

  return (
    <div className={`aiur-shell${collapsed ? ' aiur-shell--collapsed' : ''}`} data-theme={theme.theme}>
      <header className="aiur-shell__topbar">
        <span className="aiur-shell__brand">Khala</span>
        <div className="aiur-shell__actions">
          {actions}
          <button
            type="button"
            className="aiur-shell__theme-toggle aiur-shell__icon-button"
            aria-label="Toggle color theme"
            title="Toggle color theme"
            onClick={() => theme.onThemeChange(theme.theme === 'dark' ? 'light' : 'dark')}
          >
            <span className="aiur-shell__theme-icon" aria-hidden="true">
              <svg className="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
              </svg>
              <svg className="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
              </svg>
            </span>
          </button>
        </div>
      </header>
      <nav className="aiur-shell__nav" aria-label="Main navigation">
        <button
          type="button"
          className="aiur-shell__nav-toggle aiur-shell__icon-button"
          aria-expanded={!collapsed}
          aria-pressed={collapsed}
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          onClick={() => onCollapsedChange(!collapsed)}
        >
          <span className="aiur-shell__nav-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M9 4v16" />
              {!collapsed && <path d="M3 4h6v16H3z" fill="currentColor" stroke="none" />}
            </svg>
          </span>
        </button>
        <ul className="aiur-shell__nav-list">
          {navigation.map(item => (
            <li key={item.id}>
              {item.content ?? (
                <a href={item.href} aria-current={item.current ? 'page' : undefined}>
                  <span className="aiur-shell__nav-label">{item.label}</span>
                  {typeof item.count === 'number' && item.count > 0 ? (
                    <span className="aiur-shell__count" aria-label={`${item.count} pending`}>
                      {item.count}
                    </span>
                  ) : null}
                </a>
              )}
            </li>
          ))}
        </ul>
      </nav>
      <main className="aiur-shell__content" aria-label="Khala">
        {children}
      </main>
    </div>
  );
}
