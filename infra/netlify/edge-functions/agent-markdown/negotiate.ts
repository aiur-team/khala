// Pure content negotiation for the agent-markdown edge function. Kept free of
// Deno and Netlify APIs so `node --test` can exercise it directly.

const MARKDOWN_TYPES = new Set(['text/markdown', 'text/plain']);

type MediaRange = { type: string; q: number };

function parseAccept(accept: string): MediaRange[] {
  const ranges: MediaRange[] = [];
  for (const part of accept.split(',')) {
    const [rawType, ...params] = part.split(';');
    const type = rawType.trim().toLowerCase();
    if (!type) continue;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.split('=');
      if (key.trim().toLowerCase() === 'q') {
        const parsed = Number.parseFloat((value ?? '').trim());
        q = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : 0;
      }
    }
    ranges.push({ type, q });
  }
  return ranges;
}

function bestQ(ranges: MediaRange[], accept: (type: string) => boolean): number {
  let best = -1;
  for (const range of ranges) if (accept(range.type) && range.q > best) best = range.q;
  return best;
}

/**
 * True when the caller is an agent that should receive markdown: the Accept
 * header is missing, names no acceptable `text/html` (so curl's wildcard-only
 * default counts), or ranks text/markdown or text/plain strictly above text/html.
 * Any browser Accept that lists text/html at least as high gets the SPA.
 */
export function prefersMarkdown(accept: string | null | undefined): boolean {
  const ranges = parseAccept(accept ?? '');
  const html = bestQ(ranges, type => type === 'text/html');
  if (html <= 0) return true;
  const markdown = bestQ(ranges, type => MARKDOWN_TYPES.has(type));
  return markdown > html;
}

/** Path patterns the edge function serves, mirrored in netlify.toml. */
export function isAgentMarkdownPath(pathname: string): boolean {
  return pathname === '/' || /^\/join\/[^/]+\/?$/.test(pathname);
}

/** The markdown body: AGENTS.md, prefixed with a join header on /join/ links. */
export function agentMarkdownBody(requestUrl: string, agentsMd: string): string {
  const { pathname } = new URL(requestUrl);
  if (!pathname.startsWith('/join/')) return agentsMd;
  const header =
    `You were given this Khala channel link: \`${requestUrl}\`. ` +
    "Follow 'Given a khala.aiur.team/join/… link' below, then call khala_join with that exact link.";
  return `${header}\n\n---\n\n${agentsMd}`;
}
