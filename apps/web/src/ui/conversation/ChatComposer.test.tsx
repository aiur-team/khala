import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChatComposer } from './ChatComposer';

type Props = Parameters<typeof ChatComposer>[0];

/** Renders once and returns the composer's markup and its element tree. */
function render(overrides: Partial<Props> = {}) {
  const props: Props = { value: '', onChange: () => {}, onSend: () => {}, ...overrides };
  let tree: ReactNode = null;
  function Capture() {
    tree = ChatComposer(props);
    return tree;
  }
  const html = renderToStaticMarkup(<Capture />);
  return { html, tree };
}

function hosts(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(hosts);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [...(typeof node.type === 'string' ? [node] : []), ...hosts(node.props.children as ReactNode)];
}

function keyDown(tree: ReactNode, init: Partial<{ key: string; shiftKey: boolean; isComposing: boolean; keyCode: number }>) {
  const textarea = hosts(tree).find(element => element.type === 'textarea')!;
  const preventDefault = vi.fn();
  (textarea.props.onKeyDown as (event: unknown) => void)({
    key: init.key ?? 'Enter', shiftKey: init.shiftKey ?? false, preventDefault,
    nativeEvent: { isComposing: init.isComposing ?? false, keyCode: init.keyCode ?? 13 },
  });
  return preventDefault;
}

describe('ChatComposer', () => {
  it('disables send while the draft is empty', () => {
    expect(render().html).toMatch(/<button class="kh-send" type="submit" disabled="" aria-label="Send">/u);
    expect(render({ value: '   ' }).html).toContain('disabled="" aria-label="Send"');
  });

  it('enables send once there is text, unless disabled or send-disabled', () => {
    expect(render({ value: 'hi' }).html).toContain('<button class="kh-send" type="submit" aria-label="Send">');
    expect(render({ value: 'hi', sendDisabled: true }).html).toContain('disabled="" aria-label="Send"');
    expect(render({ value: 'hi', disabled: true }).html).toContain('disabled="" aria-label="Send"');
  });

  it('sends on Enter but not on Shift+Enter', () => {
    const onSend = vi.fn();
    const { tree } = render({ value: 'hi', onSend });
    expect(keyDown(tree, { shiftKey: true })).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(keyDown(tree, {})).toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('does not send while an IME composition is active', () => {
    const onSend = vi.fn();
    const { tree } = render({ value: 'にほん', onSend });
    keyDown(tree, { keyCode: 229 });
    keyDown(tree, { isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('renders the §10 form with the default placeholder and a hidden label', () => {
    const { html } = render();
    expect(html).toContain('<form class="kh-comp"><label class="sr-only" for="kh-input">Message</label><textarea class="kh-input" id="kh-input" rows="1" placeholder="Message the Khala"');
    expect(render({ placeholder: 'Reply' }).html).toContain('placeholder="Reply"');
  });

  it('draws the send arrow as an svg, not a text glyph', () => {
    const { html } = render({ value: 'hi' });
    const send = html.slice(html.indexOf('<button class="kh-send"'));
    expect(send).toMatch(/^<button[^>]*><svg[^>]*stroke-width="2.4"[^>]*><path d="M12 19V5M5 12l7-7 7 7"><\/path><\/svg><\/button>/u);
    expect(html).not.toContain('↑');
  });

  it('renders the chips bar above the form only when there are targets', () => {
    expect(render().html).toMatch(/^<form/u);
    const target = { id: 'p-maya', kind: 'human', label: 'Maya', display: 'Maya', hue: 330, ownerHue: 330, ownerInitials: 'MC', ownerId: 'o-maya', isViewer: false } as const;
    expect(render({ mentionTargets: [target] }).html).toMatch(/^<div class="kh-to">.*<\/div><form class="kh-comp">/u);
  });

  it('picks a mention instead of sending on Enter while the suggestions are open', () => {
    const onSend = vi.fn();
    const onChange = vi.fn();
    const target = { id: 'p-maya', kind: 'human', label: 'Maya', display: 'Maya', hue: 330, ownerHue: 330, ownerInitials: 'MC', ownerId: 'o-maya', isViewer: false } as const;
    const { html, tree } = render({ value: '@', onSend, onChange, mentionTargets: [target] });
    expect(html).toContain('role="listbox" id="kh-mention-list"');
    expect(html).toContain('aria-expanded="true" aria-controls="kh-mention-list" aria-activedescendant="kh-mention-opt-p-maya"');
    expect(keyDown(tree, {})).toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith('@Maya ');
  });

  it('still sends on Enter after an @ when there is no one to suggest', () => {
    const onSend = vi.fn();
    const { html, tree } = render({ value: '@', onSend });
    expect(html).not.toContain('kh-mpop');
    keyDown(tree, {});
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('marks the draft as a collapsed combobox', () => {
    const target = { id: 'p-maya', kind: 'human', label: 'Maya', display: 'Maya', hue: 330, ownerHue: 330, ownerInitials: 'MC', ownerId: 'o-maya', isViewer: false } as const;
    const { html } = render({ value: 'hi', mentionTargets: [target] });
    expect(html).toContain('role="combobox" aria-autocomplete="list" aria-expanded="false"');
    expect(html).not.toContain('aria-activedescendant');
  });

  it('keeps the draft a plain textbox when there is no one to mention', () => {
    const { html } = render({ value: '@' });
    expect(html).not.toContain('role="combobox"');
    expect(html).not.toContain('aria-autocomplete');
    expect(html).not.toContain('aria-expanded');
  });

  it('honours a controlled chipsOpen', () => {
    const targets = ['a', 'b', 'c', 'd'].map(id => ({ id, kind: 'agent', label: id, display: id, hue: 210, ownerHue: 214, ownerInitials: 'YO', ownerId: 'o', isViewer: false }) as const);
    expect(render({ mentionTargets: targets, chipsOpen: true }).html).toContain('class="kh-to is-open"');
    expect(render({ mentionTargets: targets, chipsOpen: false }).html).not.toContain('is-open');
  });
});
