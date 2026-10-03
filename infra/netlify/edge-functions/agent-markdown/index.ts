// Netlify Edge Function: serve AGENTS.md as markdown to agents on `/` and
// `/join/*`, and the normal site to browsers. Routes are declared in
// netlify.toml ([[edge_functions]]). Never log the request URL: /join/ links
// carry an invitation token.
import { agentMarkdownBody, isAgentMarkdownPath, prefersMarkdown } from './negotiate.ts';

type Context = { next: () => Promise<Response> };

let agentsMdCache: string | undefined;

async function loadAgentsMd(requestUrl: string): Promise<string | undefined> {
  if (agentsMdCache !== undefined) return agentsMdCache;
  const response = await fetch(new URL('/AGENTS.md', requestUrl), { headers: { accept: 'text/markdown' } });
  if (!response.ok) return undefined;
  agentsMdCache = await response.text();
  return agentsMdCache;
}

function withVary(response: Response): Response {
  const copy = new Response(response.body, response);
  copy.headers.append('vary', 'Accept');
  return copy;
}

export default async function agentMarkdown(request: Request, context: Context): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  if ((method !== 'GET' && method !== 'HEAD') || !isAgentMarkdownPath(url.pathname) || !prefersMarkdown(request.headers.get('accept'))) {
    return withVary(await context.next());
  }
  let agentsMd: string | undefined;
  try {
    agentsMd = await loadAgentsMd(request.url);
  } catch {
    agentsMd = undefined;
  }
  if (agentsMd === undefined) return withVary(await context.next());
  const body = agentMarkdownBody(request.url, agentsMd);
  return new Response(method === 'HEAD' ? null : body, {
    status: 200,
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'cache-control': 'no-store',
      vary: 'Accept',
      'x-content-type-options': 'nosniff',
    },
  });
}
