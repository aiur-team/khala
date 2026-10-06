import opencodeLogo from './assets/opencode.svg';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { flatMentionOrder, insertMention, MentionChips, type MentionTarget } from './MentionChips';

const kevin: MentionTarget = { id: 'p-kevin', kind: 'human', label: 'Kevin', display: 'Kevin', hue: 214, ownerHue: 214, ownerInitials: 'YO', ownerId: 'o-kevin', isViewer: true };
const maya: MentionTarget = { id: 'p-maya', kind: 'human', label: 'Maya', display: 'Maya', hue: 330, ownerHue: 330, ownerInitials: 'MC', ownerId: 'o-maya', isViewer: false };
const kai: MentionTarget = { id: 'p-kai', kind: 'human', label: 'Kai', display: 'Kai', hue: 150, ownerHue: 150, ownerInitials: 'KA', ownerId: 'o-kai', isViewer: false };
const claude: MentionTarget = { id: 'a1', kind: 'agent', label: 'Claude', display: 'Claude', hue: 210, ownerHue: 214, ownerInitials: 'KE', harness: 'claude', ownerId: 'o-kevin', isViewer: false };
const codex: MentionTarget = { id: 'a2', kind: 'agent', label: 'Codex', display: 'Codex', hue: 150, ownerHue: 330, ownerInitials: 'MC', harness: 'codex', ownerId: 'o-maya', isViewer: false };
const codex2: MentionTarget = { ...codex, id: 'a3', display: 'Codex #2' };

type Props = Parameters<typeof MentionChips>[0];
const props = (overrides: Partial<Props> = {}): Props => ({
  targets: [maya, codex, kevin, claude], value: '', onChange: () => {}, open: false, onOpenChange: () => {}, ...overrides,
});
const html = (overrides: Partial<Props> = {}) => renderToStaticMarkup(<MentionChips {...props(overrides)} />);

/** Every host element in the tree, with hook-free components expanded. */
function hosts(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(hosts);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  if (typeof node.type === 'function') return hosts((node.type as (p: unknown) => ReactNode)(node.props));
  return [...(typeof node.type === 'string' ? [node] : []), ...hosts(node.props.children as ReactNode)];
}
const mentionButton = (tree: ReactNode, id: string) => hosts(tree).find(element => element.props['data-kh-mention'] === id)!;

describe('registry mention avatars', () => {
  it('shows the OpenCode logo and retains unknown client names', () => {
    const tree = <MentionChips {...props({ targets: [{ ...claude, harness: 'opencode' as NonNullable<MentionTarget['harness']> }] })} />;
    expect(hosts(tree).find(element => element.type === 'img')?.props.src).toBe(opencodeLogo);
    const unknown = html({ targets: [{ ...claude, harness: 'cline' as NonNullable<MentionTarget['harness']> }] });
    expect(unknown).not.toContain('<img');
    expect(unknown).toContain('@Claude');
  });
});

describe('insertMention', () => {
  it('follows the khInsert spacing rule', () => {
    expect(insertMention('hi', 'Claude')).toBe('hi @Claude ');
    expect(insertMention('', 'Maya')).toBe('@Maya ');
    expect(insertMention('hi ', 'Kai')).toBe('hi @Kai ');
    expect(insertMention('hi\n', 'Kai')).toBe('hi\n@Kai ');
  });
});

describe('MentionChips', () => {
  it('orders the viewer’s agents first, then each human followed by their agents', () => {
    expect(flatMentionOrder([maya, codex, kevin, claude]).map(target => target.id)).toEqual(['a1', 'p-maya', 'a2']);
    const markup = html();
    expect(markup).toMatch(/^<div class="kh-to"><div class="kh-to-flat" role="toolbar" aria-label="Mention">/u);
    expect(markup).toContain('<button type="button" class="kh-chip kh-chip-a" style="--oh:214" data-kh-mention="a1"><img src="');
    expect(markup).toContain('alt=""/>@Claude<i>KE</i></button>');
    expect(markup).toContain('<button type="button" class="kh-chip kh-chip-h" style="--oh:330" data-kh-mention="p-maya"><i>MC</i>@Maya</button>');
    expect(markup.indexOf('"a1"')).toBeLessThan(markup.indexOf('"p-maya"'));
    expect(markup.indexOf('"p-maya"')).toBeLessThan(markup.indexOf('"a2"'));
    expect(markup).not.toContain('kh-to-tog');
    expect(markup).not.toContain('p-kevin');
  });

  it('shows the first three chips and a +N toggle past three', () => {
    const markup = html({ targets: [kevin, claude, maya, codex, codex2, kai] });
    expect(markup.match(/data-kh-mention=/gu)).toHaveLength(3);
    expect(markup).toMatch(/<button type="button" class="kh-to-tog" aria-expanded="false"[^>]*>\+2<svg[^>]*stroke-width="2.6"[^>]*><path d="m6 15 6-6 6 6"><\/path><\/svg><\/button>/u);
  });

  it('expands into a per-human grid with the viewer row only when the viewer has agents', () => {
    const open = html({ targets: [kevin, claude, maya, codex, codex2, kai], open: true });
    expect(open).toMatch(/^<div class="kh-to is-open"><div class="kh-to-grid"/u);
    expect(open.match(/class="kh-to-h"/gu)).toHaveLength(3);
    expect(open).toContain('<div class="kh-to-h"><span class="kh-chip kh-chip-h kh-chip-me" style="--oh:214"><i>YO</i>You</span></div>');
    expect(open).toContain('<div class="kh-to-foot"><span>Mention a human or agent</span><button type="button" class="kh-to-tog" aria-expanded="true"');
    expect(open).toMatch(/>Less<svg/u);

    const noViewerAgents = html({ targets: [kevin, maya, codex, codex2, kai], open: true });
    expect(noViewerAgents.match(/class="kh-to-h"/gu)).toHaveLength(2);
    expect(noViewerAgents).not.toContain('kh-chip-me');
  });

  it('toggles open and closed through onOpenChange', () => {
    const onOpenChange = vi.fn();
    const targets = [kevin, claude, maya, codex, codex2];
    const toggle = (open: boolean) => hosts(MentionChips(props({ targets, open, onOpenChange }))).find(element => element.props.className === 'kh-to-tog')!;
    (toggle(false).props.onClick as () => void)();
    (toggle(true).props.onClick as () => void)();
    expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
  });

  it('inserts @label when a chip is clicked', () => {
    const onChange = vi.fn();
    const tree = MentionChips(props({ value: 'hi', onChange }));
    (mentionButton(tree, 'a2').props.onClick as () => void)();
    (mentionButton(tree, 'p-maya').props.onClick as () => void)();
    expect(onChange.mock.calls).toEqual([[insertMention('hi', 'Codex')], [insertMention('hi', 'Maya')]]);
  });

  it('renders the viewer’s own chip as a static span', () => {
    const tree = MentionChips(props({ targets: [kevin, claude, maya, codex, codex2], open: true }));
    const you = hosts(tree).find(element => String(element.props.className).includes('kh-chip-me'))!;
    expect(you.type).toBe('span');
    expect(you.props['data-kh-mention']).toBeUndefined();
  });

  it('renders nothing without targets', () => {
    expect(html({ targets: [] })).toBe('');
    expect(html({ targets: [kevin] })).toBe('');
  });
});
