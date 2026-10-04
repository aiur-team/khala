import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Avatar } from './Avatar';

const agent = {
  kind: 'agent', label: 'Claude #2', hue: 330, ownerHue: 330, ownerSwatch: '#ce277a', ownerInitials: 'MC', ownerHost: 'maya-mbp',
  logo: '/logo.svg', initials: 'CL',
} as const;

describe('Avatar', () => {
  it('renders an agent as a button in its owner\'s colour, with its logo and owner badge', () => {
    const html = renderToStaticMarkup(<Avatar {...agent} />);
    expect(html).toMatch(/<button type="button" class="kh-av kh-aav" style="--h:330;--oh:330;--hc:#ce277a" aria-label="Claude #2">/u);
    expect(html).toContain('<img src="/logo.svg" alt=""/>');
    expect(html).toContain('<span class="kh-own" style="--oh:330;--hc:#ce277a" title="Running on maya-mbp">MC</span>');
  });

  it('falls back to initials for an agent with no harness logo', () => {
    const html = renderToStaticMarkup(<Avatar {...agent} logo={null} />);
    expect(html).toContain('<span class="kh-ini">CL</span>');
    expect(html).not.toContain('<img');
  });

  it('renders a static avatar as a decorative span', () => {
    const html = renderToStaticMarkup(<Avatar {...agent} static />);
    expect(html).toMatch(/<span class="kh-av kh-aav" style="--h:330;--oh:330;--hc:#ce277a" aria-hidden="true">/u);
    expect(html).not.toContain('<button');
  });

  it('hides a ghost avatar from assistive technology', () => {
    const html = renderToStaticMarkup(<Avatar {...agent} ghost />);
    expect(html).toMatch(/<span class="kh-av kh-aav ghost"[^>]* aria-hidden="true">/u);
  });

  it('renders a human with initials on its owner hue', () => {
    const html = renderToStaticMarkup(<Avatar kind="human" label="Maya Chen" hue={330} initials="MC" />);
    expect(html).toBe('<button type="button" class="kh-av kh-hav" style="--oh:330" aria-label="Maya Chen">MC</button>');
  });

  it('renders the generic channel and overflow avatars', () => {
    expect(renderToStaticMarkup(<Avatar kind="generic" />)).toBe('<span class="kh-av kh-gen" aria-hidden="true">#</span>');
    expect(renderToStaticMarkup(<Avatar kind="more" count={3} />)).toBe('<span class="kh-av kh-more">+3</span>');
  });
});
