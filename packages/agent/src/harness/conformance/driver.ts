import type { HarnessAdapter } from '../adapter';
import type { WakeDriver } from '../../wake/driver';
import type { SessionFiles } from '../../state';

export type FakeSession = {
  id: string;
  mcpEnv: NodeJS.ProcessEnv;
  mcpMeta?: Record<string, unknown>;
  workspace?: string;
};
export type HookEvent = 'prompt' | 'tool' | 'stop';

/** Harness syntax and transport seams only; the runner owns assertions and policy. */
export interface FakeHarnessDriver {
  /** Cursor guards allow a new batch during a retry, but never replay a delivered batch. */
  syncGuard?: 'cursor';
  newSession(): FakeSession;
  hookStdin(event: HookEvent, session: FakeSession & { continuation?: boolean; promptText?: string }): string;
  readHookStdout(stdout: string): { kind: 'context' | 'continue' | 'none'; frame?: string };
  /** Replace only external I/O, keeping the adapter's real wake implementation. */
  wakeProbe?(adapter: HarnessAdapter): {
    drivers: readonly WakeDriver[];
    prompt(): string | undefined;
    prepare?(files: SessionFiles): Promise<void>;
  };
}

export function claudeStyleDriver(envKey: string): FakeHarnessDriver {
  return {
    newSession: () => ({ id: 'conformance-session', mcpEnv: { [envKey]: 'conformance-session' } }),
    hookStdin: (event, session) => JSON.stringify({
      session_id: session.id,
      hook_event_name: { prompt: 'UserPromptSubmit', tool: 'PostToolUse', stop: 'Stop' }[event],
      stop_hook_active: session.continuation ?? false,
      ...(session.promptText !== undefined ? { prompt: session.promptText } : {}),
    }),
    readHookStdout(stdout) {
      if (!stdout) return { kind: 'none' };
      const output = JSON.parse(stdout);
      if (output.decision === 'block') return { kind: 'continue', frame: output.reason };
      if (output.hookSpecificOutput?.additionalContext) return { kind: 'context', frame: output.hookSpecificOutput.additionalContext };
      return { kind: 'none' };
    },
  };
}
