import type { SessionFiles } from '../state';

export type WakeDriverContext = Readonly<{
  files: SessionFiles;
  harness: string;
  sessionId: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  now: number;
}>;

/** A driver sends the fixed wake line through one harness-supported transport. */
export interface WakeDriver {
  readonly id: string;
  readonly rung: number;
  readonly optIn: boolean;
  readonly minIdleMs: number;
  /** Existing Codex queue argv stays fixed until U13; async watchers carry no nonce. */
  readonly verification?: 'nonce' | 'none';
  available(ctx: WakeDriverContext): boolean | Promise<boolean>;
  wake(ctx: WakeDriverContext, line: string): void | Promise<void>;
}
