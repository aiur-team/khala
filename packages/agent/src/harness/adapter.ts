import type { HarnessId } from '@khala/contracts/m1/harness';
import type { InstallDeps } from '../install/main';
import type { WakeDriver } from '../wake/driver';
import type { EmptyPrompt } from '../wake/terminal/prompt-guard';

import type { SessionSource } from './session-sources';
import type { HookIO } from './deliver-core';
import type { SessionFiles } from '../state';
export type { SessionSource } from './session-sources';

/** Hook dialect parsing and stdout, separate from shared delivery state. */
export type DeliverCodec = Readonly<{
  parse(stdin: string): { sessionId?: string; event: 'start' | 'prompt' | 'tool' | 'stop'; continuation: boolean; promptText?: string; workspace?: string; replay?: boolean } | null;
  render(kind: 'prompt' | 'tool' | 'stop', frame: string): string;
  noop(kind?: 'start' | 'prompt' | 'tool' | 'stop'): string;
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
  wakeLadder?: readonly WakeDriver[];
  /** Native plugins poll through delivery hooks rather than an external transport. */
  pollIdleWake?: (files: SessionFiles, io: HookIO, replay?: boolean) => Promise<string | undefined>;
  /** Measured empty input text and cursor column for safe terminal wakes. */
  emptyPrompt?: EmptyPrompt;
  /** Planned consent-gated fallbacks; runtime availability remains explicit. */
  wakeConsentDrivers?: readonly Pick<WakeDriver, 'id' | 'rung' | 'optIn'>[];
  /** Diagnostic prefix for wake errors; defaults to wake. */
  wakeWarningName?: string;
  /** Restore a known session before the first MCP request. */
  restoreAtStartup: boolean;
  /** Claude's status exposes the external watcher lease. */
  watcherStatus?: boolean;
}>;
