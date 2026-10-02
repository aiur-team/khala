import type { Harness } from '@khala/contracts/m1/agent-join';

export function resolveHarness(argv: readonly string[], env: NodeJS.ProcessEnv): Harness | 'invalid' {
  const index = argv.indexOf('--harness');
  if (index !== -1) {
    const value = argv[index + 1];
    return value === 'claude' || value === 'codex' ? value : 'invalid';
  }
  if (env.KHALA_MCP_HARNESS === 'claude' || env.KHALA_MCP_HARNESS === 'codex') return env.KHALA_MCP_HARNESS;
  return env.CLAUDE_CODE_SESSION_ID !== undefined ? 'claude' : 'codex';
}

export function resolveSessionId(
  harness: Harness,
  meta: Readonly<Record<string, unknown>> | undefined,
  env: NodeJS.ProcessEnv,
): string | null {
  const value = harness === 'claude' ? env.CLAUDE_CODE_SESSION_ID
    : typeof meta?.threadId === 'string' ? meta.threadId : env.CODEX_THREAD_ID;
  return typeof value === 'string' && value.match(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)?.[0] === value ? value : null;
}
