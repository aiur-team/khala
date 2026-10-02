import type { AiurShellProps } from './types';

/**
 * The hosted-content root for a screen mounted outside the Khala frame. The
 * signed-in app renders `ui/khala/KhalaApp` instead. This wrapper has no
 * topbar or navigation in either mode, so it ignores the navigation, title,
 * header, action and collapse props.
 */
export function AiurShell({ className = '', theme, children }: AiurShellProps) {
  return (
    <div className={`khala-content-root${className ? ` ${className}` : ''}`} data-theme={theme.theme}>
      <div className="khala-content-main">{children}</div>
    </div>
  );
}
