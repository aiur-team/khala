import type { Harness } from '@khala/contracts/m1/agent-join';
import { adapterFor } from '../harness';
import { resolveSources, type ResolvedSession, type SessionContext } from '../harness/session-sources';

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

export async function resolveSession(harness: Harness, meta: Readonly<Record<string, unknown>> | undefined,
  env: NodeJS.ProcessEnv, context: Omit<SessionContext, 'harness'> = {}): Promise<ResolvedSession | null> {
  return resolveSources(adapterFor(harness)?.sessionSources ?? [], meta, env, { ...context, harness });
}

export async function resolveSessionId(harness: Harness, meta: Readonly<Record<string, unknown>> | undefined,
  env: NodeJS.ProcessEnv): Promise<string | null> {
  return (await resolveSession(harness, meta, env))?.sessionId ?? null;
}
