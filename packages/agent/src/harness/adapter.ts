import type { HarnessId } from '@khala/contracts/m1/harness';
import type { InstallDeps } from '../install/main';
import type { CodexWaker, CodexWakerDeps } from '../wake/codex';

export type SessionSource = (meta: Readonly<Record<string, unknown>> | undefined, env: NodeJS.ProcessEnv) => unknown;

/** Delivery remains in the hook entry points until U3b supplies these codecs. */
export type DeliverCodec = Readonly<{
  parse(stdin: string): { sessionId?: string; event: 'prompt' | 'tool' | 'stop'; continuation: boolean; promptText?: string; workspace?: string } | null;
  render(kind: 'prompt' | 'tool' | 'stop', frame: string): string;
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
  /** Claude's status exposes the external watcher lease. */
  watcherStatus?: boolean;
}>;
