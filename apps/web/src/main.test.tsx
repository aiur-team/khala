import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const rendered: ReactElement[] = [];

vi.mock('react-dom/client', () => ({
  createRoot: vi.fn(() => ({ render: (element: ReactElement) => rendered.push(element), unmount: vi.fn() })),
}));

afterEach(() => {
  rendered.length = 0;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

// No DOM environment is available, so the entry is booted against a bare
// mount element and the element it hands React is rendered statically.
describe('the hosted entry', () => {
  it('renders an explicit unavailable screen, not a blank page, when PUBLIC_HOMESERVER_ORIGIN is missing', async () => {
    vi.stubEnv('PUBLIC_APP_ORIGIN', 'https://khala.aiur.team');
    vi.stubEnv('PUBLIC_HOMESERVER_ORIGIN', '');
    vi.stubGlobal('document', { querySelector: () => ({}) });

    await import('./main');

    expect(rendered).toHaveLength(1);
    const markup = renderToStaticMarkup(rendered[0]!);
    expect(markup).toContain('Khala is unavailable');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('PUBLIC_HOMESERVER_ORIGIN');
  });
});
