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
        <span className="aiur-shell__brand">AIUR</span>
        <div className="aiur-shell__actions">
          {actions}
          <button
            type="button"
            className="aiur-shell__theme-toggle"
            onClick={() => theme.onThemeChange(theme.theme === 'dark' ? 'light' : 'dark')}
          >
            Use {theme.theme === 'dark' ? 'light' : 'dark'} theme
          </button>
        </div>
      </header>
      <nav className="aiur-shell__nav" aria-label="Main navigation">
        <button
          type="button"
          className="aiur-shell__nav-toggle"
          aria-expanded={!collapsed}
          onClick={() => onCollapsedChange(!collapsed)}
        >
          {collapsed ? 'Expand navigation' : 'Collapse navigation'}
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
