import { createHash } from 'node:crypto';
import path from 'node:path';
import { isInternalHarnessArgument, isInternalSessionArgument } from '@khala/contracts/internal/command';
import {
  INTERNAL_DISCOVERY_DIRECTORY, INTERNAL_GRANT_DESCRIPTOR_FILE, discoveryPrincipalPreimage,
} from '@khala/contracts/internal/discovery-descriptor';

// The installed Codex and OpenCode `mcp-serve` entries carry no `--internal-descriptor`:
// one entry serves every session of its harness. Each tool call names the calling
// session instead, and the entry acts only as that session's own `grant.json` below
// `discovery/<principal>/`, the principal the launcher derived from the same harness
// and session when that session ran `khala internal discovery`. A call that names no
// session is refused: it never falls back to another session's grant.

export const CODEX_HARNESS = 'codex';

export type HarnessSession = Readonly<{ harness: string; sessionId: string }>;

/** Maps a calling session to its own granted descriptor. */
export type SessionGrants = (session: HarnessSession) => string;

/**
 * The session one `tools/call` comes from. Codex 0.154.0 sends its thread on every call
 * as `_meta.threadId`, the same ID it exports to the agent's commands as `CODEX_THREAD_ID`
 * and so the one an agent passes to `khala internal discovery --session`. No other
 * harness names its session to an MCP server yet, so every other call has none.
 */
export function harnessSessionFromMeta(meta: Readonly<Record<string, unknown>> | undefined): HarnessSession | null {
  const threadId = meta?.threadId;
  return isInternalSessionArgument(threadId) ? { harness: CODEX_HARNESS, sessionId: threadId } : null;
}

/** `<internalRoot>/discovery/<principal>/grant.json` for one harness session. */
export function sessionGrants(internalRoot: string): SessionGrants {
  return ({ harness, sessionId }) => {
    if (!isInternalHarnessArgument(harness) || !isInternalSessionArgument(sessionId)) throw new Error('invalid harness session');
    const principal = `agent_${createHash('sha256').update(discoveryPrincipalPreimage(harness, sessionId)).digest('base64url')}`;
    return path.join(internalRoot, INTERNAL_DISCOVERY_DIRECTORY, principal, INTERNAL_GRANT_DESCRIPTOR_FILE);
  };
}
