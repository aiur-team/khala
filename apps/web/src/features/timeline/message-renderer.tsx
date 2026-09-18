// Renders canonical message content as inert text/code. React text nodes are
// never interpreted as markup, no `dangerouslySetInnerHTML` is used anywhere
// in this module, and no element that fetches remote content (`img`, `link`,
// `iframe`) or navigates (`a`) is ever created from message bytes — link and
// image rendering waits for a pinned sanitizer/parser (KTD4; see README).
// Rendering helper accepts canonical content, never a raw trusted-HTML marker
// supplied by remote peers.

import type { ReactNode } from 'react';
import type { MessageContent } from '@khala/contracts/messaging/index';

type Segment = Readonly<{ kind: 'text'; text: string }> | Readonly<{ kind: 'code'; text: string; language: string | null }>;

const FENCE = /```([^\n`]*)\n([\s\S]*?)```/g;

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

/** Canonical message content in, inert React nodes out. Never accepts pre-rendered HTML. */
export function renderMessageContent(content: MessageContent): ReactNode {
  if (content.v !== 1 || content.kind !== 'text') {
    return <p className="message-content__unavailable">Unsupported message content.</p>;
  }
  return (
    <>
      {splitFences(content.body).map((segment, index) =>
        segment.kind === 'code' ? (
          <pre key={index} className="message-content__code">
            {segment.language ? <span className="message-content__code-lang">{segment.language}</span> : null}
            <code>{segment.text}</code>
          </pre>
        ) : (
          <p key={index} className="message-content__text">
            {segment.text}
          </p>
        ),
      )}
    </>
  );
}
