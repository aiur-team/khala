import type { HarnessId } from '@khala/contracts/m1/harness';
import type { InstallDeps } from '../install/main';
import type { CodexWaker, CodexWakerDeps } from '../wake/codex';

export type SessionSource = (meta: Readonly<Record<string, unknown>> | undefined, env: NodeJS.ProcessEnv) => unknown;

/** Hook dialect parsing and stdout, separate from shared delivery state. */
export type DeliverCodec = Readonly<{
  parse(stdin: string): { sessionId?: string; event: 'prompt' | 'tool' | 'stop'; continuation: boolean; promptText?: string; workspace?: string } | null;
  render(kind: 'prompt' | 'tool' | 'stop', frame: string): string;
  noop(kind?: 'prompt' | 'tool' | 'stop'): string;
  /** Some prompt hooks can only record activity, without injecting context. */
  promptAcceptsContext: boolean;
  /** Cursor silently tolerates a closed stdout pipe; Claude-style reports it. */
  suppressOutputErrors: boolean;
  promptDeliversWithoutWake: boolean;
  fallbackSession?: string;
}>;

export type HarnessAdapter = Readonly<{
  id: HarnessId;
  sessionSources: readonly SessionSource[];
  codec: DeliverCodec | undefined;
  install?: (flags: readonly string[], deps: InstallDeps) => Promise<number>;
  uninstall?: (flags: readonly string[], deps: InstallDeps) => Promise<number>;
  waker?: (deps: CodexWakerDeps) => CodexWaker;
  rejoinable(source: string): boolean;
  /** Restore a known session before the first MCP request. */
  restoreAtStartup: boolean;
  /** Claude's status exposes the external watcher lease. */
  watcherStatus?: boolean;
}>;
