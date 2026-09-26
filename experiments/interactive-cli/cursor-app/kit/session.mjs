// Cursor-side session identity for the proof kit. The Khala stand-in (batch
// tokens, generation fencing, acknowledgement) is the Claude proof's store.
import { readFile, rm, writeFile } from 'node:fs/promises';
import { openStore } from '../../claude/marketplace/plugins/khala-proof/lib/store.mjs';

export { frame } from '../../claude/marketplace/plugins/khala-proof/lib/store.mjs';

// A resumed Cursor chat keeps its conversation_id across an app restart, so the
// binding key also carries the sessionStart session_id. Every restart is a new
// generation and fences whatever the previous process never acknowledged.
export const SESSION_ENV = 'KHALA_CURSOR_SESSION';
export const CLOUD_SESSION = 'cloud';
export const CALLER_TTL_MS = 10_000;

export function stateDirFrom(env) {
  if (env.KHALA_PROOF_STATE) return env.KHALA_PROOF_STATE;
  // Beside the project, so Cursor's own file views never show proof state.
  return env.CURSOR_PROJECT_DIR ? `${env.CURSOR_PROJECT_DIR}.khala-state` : null;
}

export async function openCursorStore(env) {
  const dir = stateDirFrom(env);
  return dir ? openStore(dir) : null;
}

export const bindingKey = (conversationId, sessionId) => `${conversationId}/${sessionId}`;

// Cursor starts one stdio MCP server per window, not per chat, and passes it no
// conversation identity. The beforeMCPExecution hook, which does receive it,
// records the caller immediately before the call; khala_read claims it once.
export async function recordCaller(store, key) {
  await writeFile(store.path('mcp-caller.json'), JSON.stringify({ key, at: Date.now() }), { mode: 0o600 });
}

export async function claimCaller(store) {
  const path = store.path('mcp-caller.json');
  let caller;
  try {
    caller = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  await rm(path, { force: true });
  return Date.now() - caller.at <= CALLER_TTL_MS ? caller.key : null;
}
