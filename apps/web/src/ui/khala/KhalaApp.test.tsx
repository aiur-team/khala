import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { KhalaApp } from './KhalaApp';

const logOut = <button type="button" className="tool-btn icon-only" aria-label="Log out">x</button>;

function render(props: Partial<Parameters<typeof KhalaApp>[0]> = {}) {
  return renderToStaticMarkup(<KhalaApp theme="dark" brandActions={logOut} list={<p>list</p>} main={<p>main</p>} {...props} />);
}

describe('KhalaApp', () => {
  it('renders the full-bleed card with list, main, detail, popover and toast hosts', () => {
    const html = render();
    expect(html).toMatch(/<div class="khala-app" data-theme="dark"><section class="section-card kh-card" id="kh-card">/u);
    expect(html).toContain('<aside class="kh-list" aria-label="Conversations"><div class="kh-brand">');
    expect(html).toContain('<p>list</p></aside><div class="kh-main"><p>main</p><div class="kh-toast" role="status"></div></div>');
    expect(html).toContain('<div class="kh-detail"></div><div class="kh-pop" hidden=""></div></section></div>');
  });

  it('puts the wordmark in the brand row and nowhere else', () => {
    const html = render();
    expect(html).toContain('<a class="wm" href="/conversations" aria-label="Khala home">khala</a>');
    expect(html.match(/class="[^"]*\bwm\b[^"]*"/gu)).toEqual(['class="wm"']);
  });

  it('holds the theme toggle then Log out in the brand actions', () => {
    const html = render();
    const actions = html.slice(html.indexOf('<span class="kh-brand-actions">'));
    expect(actions.indexOf('aria-label="Toggle color theme"')).toBeGreaterThan(-1);
    expect(actions.indexOf('aria-label="Toggle color theme"')).toBeLessThan(actions.indexOf('aria-label="Log out"'));
    expect(actions.indexOf('aria-label="Log out"')).toBeLessThan(actions.indexOf('</span></div>'));
  });

  it('toggles .in-thread and .has-detail', () => {
    expect(render({ inThread: true })).toContain('class="section-card kh-card in-thread"');
    expect(render({ inThread: false })).not.toContain('in-thread');
    expect(render({ detail: <p>detail</p> })).toContain('class="section-card kh-card has-detail"');
  });

  it('shows the Live badge only while live', () => {
    expect(render()).not.toContain('Live');
    expect(render({ live: true })).toContain('class="status-badge status-badge-live brand-live" role="status"');
  });

  it('renders a single-pane frame with the brand in main when there is no list', () => {
    const html = render({ list: undefined });
    expect(html).toContain('class="section-card kh-card kh-solo"');
    expect(html).not.toContain('class="kh-list"');
    expect(html).toContain('<div class="kh-main"><div class="kh-brand">');
  });

  it('renders an overlay at card level, outside both panes', () => {
    expect(render({ overlay: <div role="dialog">create</div> }))
      .toContain('<div class="kh-pop" hidden=""></div><div role="dialog">create</div></section>');
  });

  it('carries the theme on the app root', () => {
    expect(render({ theme: 'light' })).toMatch(/<div class="khala-app" data-theme="light">/u);
  });
});
