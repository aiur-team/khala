/**
 * The frozen surface of the Khala Claude plugin. Downstream tickets fill in the
 * hook bodies, the bundled skill and the installer; none of them may add to or
 * rename anything here without amending decision 27 and this list.
 */

/**
 * Hook events the manifest may register, and the stubs each one runs. `Stop`
 * carries the synchronous delivery hook and the `asyncRewake` idle watcher armed
 * on it (the #178 amendment); there is no `UserPromptSubmit` registration.
 */
export const FROZEN_HOOK_EVENTS = {
  UserPromptSubmit: ['hooks/user-prompt-submit.mjs'],
  PostToolUse: ['hooks/post-tool-use.mjs'],
  Stop: ['hooks/stop.mjs', 'hooks/stop-watcher.mjs'],
  SessionEnd: ['hooks/session-end.mjs'],
} as const;

/** The hook command that must be registered with `asyncRewake: true`. */
export const FROZEN_WATCHER_SCRIPT = 'hooks/stop-watcher.mjs';

/** The one bundled skill, and the exact `/khala <verb>` forms it resolves. */
export const FROZEN_SKILL_NAME = 'khala';
export const FROZEN_COMMAND_VERBS = ['send', 'read', 'create', 'join', 'who'] as const;

/** The one MCP server entry, launched as `khala mcp-serve`, and its tools. */
export const FROZEN_MCP_SERVER = { name: 'khala', command: 'khala', args: ['mcp-serve'] } as const;
/**
 * Marks the plugin's own MCP entry so `mcp-serve` binds to the Claude session. The
 * session ID alone is not enough: every process a Claude Bash tool starts inherits it.
 */
export const CLAUDE_MCP_ENV = { KHALA_MCP_HARNESS: 'claude' } as const;

/** Where the bundled skill lives, and the verbs this plugin version dispatches. */
export const SKILL_FILE = 'skills/khala/SKILL.md';
export const DISPATCHED_VERBS = ['send', 'read', 'create', 'join', 'who'] as const;
export const FROZEN_MCP_TOOLS = [
  'khala_send',
  'khala_read',
  'khala_status',
  'khala_listening_mode',
  'khala_create_channel',
  'khala_list_channels',
  'khala_request_channel_access',
  'khala_list_agents',
] as const;

export const FROZEN_PLUGIN_NAME = 'khala';
