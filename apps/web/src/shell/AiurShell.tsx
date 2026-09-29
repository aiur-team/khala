import type { AiurShellProps } from './types';
import aiurLogo from '../landing/public/assets/aiur-logo.png';

export function AiurShell({ mode, brandHref = '/new', navigation, sidebar, actions, theme, collapsed, onCollapsedChange, children }: AiurShellProps) {
  if (mode === 'hosted-content') {
    return (
      <div className={`khala-content-root${sidebar ? ' khala-content-root--channels' : ''}`} data-theme={theme.theme}>
        {sidebar ? <aside className="khala-content-sidebar" aria-label="Channels">{sidebar}</aside> : null}
        <div className="khala-content-main">{children}</div>
      </div>
    );
  }

  return (
    <div className={`aiur-shell${collapsed ? ' aiur-shell--collapsed' : ''}${sidebar ? ' aiur-shell--channels' : ''}`} data-theme={theme.theme}>
      <header className="aiur-shell__topbar">
        <a className="aiur-shell__brand" href={brandHref}>
          <img src={aiurLogo} alt="" width="1215" height="1068" />
          <span>KHALA</span>
        </a>
        <div className="aiur-shell__actions">
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
          {actions}
        </div>
      </header>
      <nav className="aiur-shell__nav" aria-label="Main navigation">
        {sidebar}
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
