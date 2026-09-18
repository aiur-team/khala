import { describe, expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AiurShell } from './AiurShell';
import { KhalaPageFrame } from './KhalaPageFrame';
import type { NavigationItem, ThemePort } from './types';

const theme: ThemePort = { theme: 'dark', onThemeChange: () => {} };
const navigation: NavigationItem[] = [{ id: 'conversations', label: 'Conversations', href: '/conversations', current: true }];

function renderStandalone(overrides: Partial<Parameters<typeof AiurShell>[0]> = {}) {
  return renderToStaticMarkup(
    <AiurShell
      mode="standalone"
      navigation={navigation}
      theme={theme}
      collapsed={false}
      onCollapsedChange={() => {}}
      {...overrides}
    >
      <KhalaPageFrame model={{ title: 'Khala', labelledBy: 'khala-heading' }}>content</KhalaPageFrame>
    </AiurShell>,
  );
}

describe('AiurShell standalone', () => {
  test('renders exactly one topbar, one navigation landmark and one main region', () => {
    const html = renderStandalone();
    expect((html.match(/class="aiur-shell__topbar"/g) ?? []).length).toBe(1);
    expect((html.match(/<nav/g) ?? []).length).toBe(1);
    expect((html.match(/<main/g) ?? []).length).toBe(1);
  });

  test('an unknown or zero count never renders as a backlog count', () => {
    const withoutCount = renderStandalone();
    expect(withoutCount).not.toContain('aiur-shell__count');

    const zero = renderToStaticMarkup(
      <AiurShell mode="standalone" navigation={[{ ...navigation[0]!, count: 0 }]} theme={theme} collapsed={false} onCollapsedChange={() => {}}>
        content
      </AiurShell>,
    );
    expect(zero).not.toContain('aiur-shell__count');

    const positive = renderToStaticMarkup(
      <AiurShell mode="standalone" navigation={[{ ...navigation[0]!, count: 3 }]} theme={theme} collapsed={false} onCollapsedChange={() => {}}>
        content
      </AiurShell>,
    );
    expect(positive).toContain('aiur-shell__count');
    expect(positive).toContain('>3<');
  });
});

describe('AiurShell hosted-content mode', () => {
  test('renders content with no shell chrome, so a host wrapper adds no duplicate landmarks', () => {
    const contentOnly = renderToStaticMarkup(
      <AiurShell mode="hosted-content" navigation={navigation} theme={theme} collapsed={false} onCollapsedChange={() => {}}>
        <KhalaPageFrame model={{ title: 'Khala', labelledBy: 'khala-heading' }}>content</KhalaPageFrame>
      </AiurShell>,
    );
    expect(contentOnly).not.toContain('<nav');
    expect(contentOnly).not.toContain('aiur-shell__topbar');
    expect(contentOnly).not.toContain('<main');

    const hostWrapper = `<div><header>Host chrome</header><nav aria-label="Host navigation"></nav><main>${contentOnly}</main></div>`;
    expect((hostWrapper.match(/<nav/g) ?? []).length).toBe(1);
    expect((hostWrapper.match(/<main/g) ?? []).length).toBe(1);
    expect((hostWrapper.match(/id="khala-heading"/g) ?? []).length).toBe(1);
  });
});
