import { describe, expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AiurShell } from './AiurShell';
import { KhalaPageFrame } from './KhalaPageFrame';
import type { NavigationItem, ShellMode, ThemePort } from './types';

const theme: ThemePort = { theme: 'dark', onThemeChange: () => {} };
const navigation: NavigationItem[] = [{ id: 'conversations', label: 'Conversations', href: '/conversations', current: true }];

function render(mode: ShellMode) {
  return renderToStaticMarkup(
    <AiurShell mode={mode} navigation={navigation} theme={theme} collapsed={false} onCollapsedChange={() => {}}>
      <KhalaPageFrame model={{ title: 'Khala', labelledBy: 'khala-heading' }}>content</KhalaPageFrame>
    </AiurShell>,
  );
}

describe('AiurShell', () => {
  test.each(['hosted-content', 'standalone'] as const)('renders %s content with no topbar or navigation', mode => {
    const html = render(mode);
    expect(html).toMatch(/^<div class="khala-content-root" data-theme="dark"><div class="khala-content-main">/u);
    expect(html).not.toContain('<nav');
    expect(html).not.toContain('<main');
    expect(html).not.toContain('aiur-shell__topbar');
  });

  test('a host wrapper adds no duplicate landmarks', () => {
    const contentOnly = render('hosted-content');
    const hostWrapper = `<div><header>Host chrome</header><nav aria-label="Host navigation"></nav><main>${contentOnly}</main></div>`;
    expect((hostWrapper.match(/<nav/g) ?? []).length).toBe(1);
    expect((hostWrapper.match(/<main/g) ?? []).length).toBe(1);
    expect((hostWrapper.match(/id="khala-heading"/g) ?? []).length).toBe(1);
  });
});
