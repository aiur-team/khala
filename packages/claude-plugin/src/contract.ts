/**
 * The frozen surface of the Khala Claude plugin. Downstream tickets fill in the
 * hook bodies, the bundled skill and the installer; none of them may add to or
 * rename anything here without amending decision 27 and this list.
 */

/** Hook events the manifest may register, and the stub each one runs. */
export const FROZEN_HOOK_EVENTS = {
  UserPromptSubmit: 'hooks/user-prompt-submit.mjs',
  PostToolUse: 'hooks/post-tool-use.mjs',
  Stop: 'hooks/stop.mjs',
  SessionEnd: 'hooks/session-end.mjs',
} as const;

/** The one bundled skill, and the exact `/khala <verb>` forms it resolves. */
export const FROZEN_SKILL_NAME = 'khala';
export const FROZEN_COMMAND_VERBS = ['send', 'read'] as const;

/** The one MCP server entry, launched as `khala mcp-serve`, and its tools. */
export const FROZEN_MCP_SERVER = { name: 'khala', command: 'khala', args: ['mcp-serve'] } as const;
export const FROZEN_MCP_TOOLS = ['khala_send', 'khala_read'] as const;

export const FROZEN_PLUGIN_NAME = 'khala';
