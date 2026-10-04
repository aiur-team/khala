import { HARNESSES, type Harness } from '@khala/contracts/m1/agent-join';
import { CURSOR_WORKSPACE_ENV, cursorSessionId } from '../cursor';

const isHarness = (value: unknown): value is Harness => (HARNESSES as readonly unknown[]).includes(value);

export function resolveHarness(argv: readonly string[], env: NodeJS.ProcessEnv): Harness | 'invalid' {
  const index = argv.indexOf('--harness');
  if (index !== -1) {
    const value = argv[index + 1];
    return isHarness(value) ? value : 'invalid';
  }
  if (isHarness(env.KHALA_MCP_HARNESS)) return env.KHALA_MCP_HARNESS;
  return env.CLAUDE_CODE_SESSION_ID !== undefined ? 'claude' : 'codex';
}

export function resolveSessionId(
  harness: Harness,
  meta: Readonly<Record<string, unknown>> | undefined,
  env: NodeJS.ProcessEnv,
): string | null {
  const value = harness === 'claude' ? env.CLAUDE_CODE_SESSION_ID
    : harness === 'cursor' ? cursorSessionId(env[CURSOR_WORKSPACE_ENV])
      : typeof meta?.threadId === 'string' ? meta.threadId : env.CODEX_THREAD_ID;
  return typeof value === 'string' && value.match(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)?.[0] === value ? value : null;
}
