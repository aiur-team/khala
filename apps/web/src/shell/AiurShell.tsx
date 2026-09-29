import type { AiurShellProps, ThemePort } from './types';
import aiurLogo from '../landing/public/assets/aiur-logo.png';
import { ThemeIcon } from './icons';

export function ThemeToggle({ theme }: Readonly<{ theme: ThemePort }>) {
  return <button
    type="button"
    className="aiur-shell__theme-toggle aiur-shell__icon-button"
    aria-label="Toggle color theme"
    title="Toggle color theme"
    onClick={() => theme.onThemeChange(theme.theme === 'dark' ? 'light' : 'dark')}
  ><ThemeIcon /></button>;
}

export function AiurShell({ mode, brandHref = '/new', className = '', title, navigation, sidebar, actions, theme, collapsed, onCollapsedChange, children }: AiurShellProps) {
  if (mode === 'hosted-content') {
    return (
      <div className={`khala-content-root${sidebar ? ' khala-content-root--channels' : ''}${className ? ` ${className}` : ''}`} data-theme={theme.theme}>
        {sidebar ? <aside className="khala-content-sidebar" aria-label="Channels">{sidebar}</aside> : null}
        <div className="khala-content-main">{children}</div>
      </div>
    );
  }

  return (
    <div className={`aiur-shell${collapsed ? ' aiur-shell--collapsed' : ''}${sidebar ? ' aiur-shell--channels' : ''}${className ? ` ${className}` : ''}`} data-theme={theme.theme}>
      <header className="aiur-shell__topbar">
        <div className="aiur-shell__brand-section"><a className="aiur-shell__brand" href={brandHref}>
          <img src={aiurLogo} alt="" width="1215" height="1068" />
          <span>KHALA</span>
        </a><div className="aiur-shell__actions">
          <ThemeToggle theme={theme} />
          {actions}
        </div></div>
        {title ? <h1 className="aiur-shell__title" dir="auto">{title}</h1> : null}
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
