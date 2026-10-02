// Renders canonical message content as inert text/code. React text nodes are
// never interpreted as markup, no `dangerouslySetInnerHTML` is used anywhere
// in this module, and no element that fetches remote content (`img`, `link`,
// `iframe`) or navigates (`a`) is ever created from message bytes — link and
// image rendering waits for a pinned sanitizer/parser (KTD4; see README).
// Rendering helper accepts canonical content, never a raw trusted-HTML marker
// supplied by remote peers.

import type { CSSProperties, ReactNode } from 'react';
import type { MessageContent } from '@khala/contracts/messaging/index';
import { segmentMentions, type MentionCandidate } from './mentions';

type Segment = Readonly<{ kind: 'text'; text: string }> | Readonly<{ kind: 'code'; text: string; language: string | null }>;

const FENCE = /```([^\n`]*)\n([\s\S]*?)```/g;
const INLINE_CODE = /`([^`\n]+)`/g;

export type RenderOptions = Readonly<{
  /** Known participants: `@` plus one of their labels becomes a mention (§7.1). */
  mentions?: readonly MentionCandidate[];
  onOpenParticipant?: (participantId: string) => void;
}>;

function splitFences(body: string): readonly Segment[] {
  const segments: Segment[] = [];
  let lastIndex = 0;
  for (const match of body.matchAll(FENCE)) {
    const index = match.index;
    if (index > lastIndex) segments.push({ kind: 'text', text: body.slice(lastIndex, index) });
    segments.push({ kind: 'code', text: match[2] ?? '', language: match[1]?.trim() || null });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < body.length) segments.push({ kind: 'text', text: body.slice(lastIndex) });
  return segments.length > 0 ? segments : [{ kind: 'text', text: body }];
}

function renderMentions(text: string, options: RenderOptions, key: string): ReactNode[] {
  if (!options.mentions) return [text];
  return segmentMentions(text, options.mentions).map((segment, index) => {
    if ('text' in segment) return segment.text;
    const open = () => options.onOpenParticipant?.(segment.participantId);
    return <span key={`${key}-${index}`} className={`kh-mention${segment.kind === 'human' ? ' kh-hm' : ''}`}
      style={{ '--mh': segment.hue } as CSSProperties} role="button" tabIndex={0} onClick={open}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        open();
      }}>@{segment.mention}</span>;
  });
}

/** Single-backtick spans become `<code>`; mentions are matched only outside them. */
function renderInline(text: string, options: RenderOptions): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(INLINE_CODE)) {
    if (match.index > lastIndex) nodes.push(...renderMentions(text.slice(lastIndex, match.index), options, `t${lastIndex}`));
    nodes.push(<code key={`c${match.index}`}>{match[1]}</code>);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) nodes.push(...renderMentions(text.slice(lastIndex), options, `t${lastIndex}`));
  return nodes;
}

/** Canonical message content in, inert React nodes out. Never accepts pre-rendered HTML. */
export function renderMessageContent(content: MessageContent, options: RenderOptions = {}): ReactNode {
  if (content.v !== 1 || content.kind !== 'text') {
    return <p className="message-content__unavailable">Unsupported message content.</p>;
  }
  return (
    <>
      {splitFences(content.body).map((segment, index) =>
        segment.kind === 'code' ? (
          <pre key={index} className="kh-pre">
            {segment.language ? <span className="kh-pre-lang">{segment.language}</span> : null}
            <code>{segment.text}</code>
          </pre>
        ) : (
          <p key={index} className="message-content__text">
            {renderInline(segment.text, options)}
          </p>
        ),
      )}
    </>
  );
}
