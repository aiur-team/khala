// Published entry, bundled to npm/dist/khala.mjs. Each command is its own lazy chunk so a
// hook never loads the MCP server or matrix-js-sdk.
import { runCli } from './cli';

const hooks: Record<string, () => Promise<{ default: (stdin: string, argv: readonly string[]) => unknown }>> = {
  'session-start': () => import('../hooks/session-start'),
  deliver: () => import('../hooks/deliver'),
  'claude-wake': () => import('../hooks/claude-wake'),
};

process.exitCode = await runCli(process.argv.slice(2), {
  mcp: () => () => import('./mcp/main'),
  watch: () => () => import('./watch'),
  local: () => () => import('./local/cli'),
  install: () => () => import('./install/main'),
  wake: () => () => import('./wake/cli'),
  hook: name => Object.hasOwn(hooks, name) ? hooks[name] : undefined,
});
