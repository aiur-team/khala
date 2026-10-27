import type { SessionFiles } from '../state';
import type { HarnessId } from '@khala/contracts/m1/harness';
import type { InstallDeps } from '../install/main';
import type { WakeDriver } from '../wake/driver';
import type { EmptyPrompt } from '../wake/terminal/prompt-guard';

import type { SessionSource } from './session-sources';
import type { HookIO } from './deliver-core';
export type { SessionSource } from './session-sources';

/** Stop continuations become user turns in most harnesses, so they never carry channel content. */
export const STOP_NUDGE = 'Khala: channel messages are waiting. Call khala_read.';

import type { DeliverCodec } from '@khala/listener';
export type { DeliverCodec } from '@khala/listener';

export type HarnessAdapter = Readonly<{
  id: HarnessId;
  sessionSources: readonly SessionSource[];
  codec: DeliverCodec | undefined;
  install?: (flags: readonly string[], deps: InstallDeps) => Promise<number>;
  uninstall?: (flags: readonly string[], deps: InstallDeps) => Promise<number>;
  wakeLadder?: readonly WakeDriver[];
  /** Resolve wake verification text when the hook only supplies a transcript. */
  hookPromptText?: (input: NonNullable<ReturnType<DeliverCodec['parse']>>, files: SessionFiles) => Promise<string | undefined>;
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
  /** Native wakes may verify outside UserPromptSubmit. */
  verifyWake?: (stdin: string, files: SessionFiles, now: number) => Promise<void>;
  /** Native notification proof, scoped to the run that reached Stop. */
  stopWakeText?: (stdin: string, files: SessionFiles, env: NodeJS.ProcessEnv) => Promise<{ text: string; at: number } | undefined>;
  /** Context for a joined session at startup, without channel content. */
  startContext?: (sessionId: string, env: NodeJS.ProcessEnv) => string;
  /** Claude's status exposes the external watcher lease. */
  watcherStatus?: boolean;
}>;
