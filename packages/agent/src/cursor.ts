import { createHash } from 'node:crypto';

/**
 * Cursor gives neither its MCP servers nor its hooks a shared per-conversation id. Both do
 * know the workspace folder: the MCP entry receives it as `KHALA_CURSOR_WORKSPACE`
 * (`${workspaceFolder}` in mcp.json) and every hook receives `workspace_roots`. So a Cursor
 * session is one Cursor window's workspace: every chat in that window shares one Khala
 * identity. A window without a folder uses the shared `cursor-default` session.
 */
export const CURSOR_WORKSPACE_ENV = 'KHALA_CURSOR_WORKSPACE';
export const CURSOR_DEFAULT_SESSION = 'cursor-default';

/** Normalizes a folder path or `file:` URI so the MCP server and hooks agree on Windows too. */
export function normalizeWorkspace(root: string): string | null {
  let value = root.trim();
  if (!value || value.includes('${')) return null;
  if (/^file:\/\//iu.test(value)) {
    try { value = decodeURIComponent(new URL(value).pathname); } catch { return null; }
  }
  value = value.replaceAll('\\', '/');
  if (/^\/[A-Za-z]:(?:\/|$)/u.test(value)) value = value.slice(1);
  // Drive-letter paths are Windows paths, which compare case-insensitively.
  if (/^[A-Za-z]:(?:\/|$)/u.test(value)) value = value.toLowerCase();
  value = value.replace(/\/+$/u, '');
  if (/^[a-z]:$/u.test(value)) value += '/';
  return value || null;
}

export function cursorSessionId(root: string | undefined): string {
  const normalized = typeof root === 'string' ? normalizeWorkspace(root) : null;
  if (normalized === null) return CURSOR_DEFAULT_SESSION;
  return `ws-${createHash('sha256').update(normalized).digest('hex').slice(0, 32)}`;
}
