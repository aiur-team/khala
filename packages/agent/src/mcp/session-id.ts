import type { Harness } from '@khala/contracts/m1/agent-join';
import { adapterFor } from '../harness';

const isHarness = (value: unknown): value is Harness => typeof value === 'string' && adapterFor(value) !== undefined;

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
  let value: unknown;
  for (const source of adapterFor(harness)?.sessionSources ?? []) {
    value = source(meta, env);
    if (value !== undefined && value !== null) break;
  }
  return typeof value === 'string' && value.match(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)?.[0] === value ? value : null;
}
