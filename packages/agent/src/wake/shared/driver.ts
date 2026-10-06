/** A driver sends the fixed wake line through one harness-supported transport. */
export interface WakeDriver<Context> {
  readonly id: string;
  readonly rung: number;
  readonly optIn: boolean;
  readonly minIdleMs: number;
  /** Verification window independent of ladder order. */
  readonly deadlineMs: number;
  /** Existing Codex queue argv stays fixed until U13; async watchers carry no nonce. */
  readonly verification?: 'nonce' | 'none';
  available(ctx: Context): boolean | Promise<boolean>;
  wake(ctx: Context, line: string): void | Promise<void>;
}
