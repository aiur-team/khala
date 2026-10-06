/** A driver sends the fixed wake line through one harness-supported transport. */
export interface WakeDriver<Context> {
  readonly id: string;
  readonly rung: number;
  readonly optIn: boolean;
  readonly minIdleMs: number;
  /** Verification window independent of ladder order. */
  readonly deadlineMs: number;
  /** Async watchers carry no nonce. */
  readonly verification?: 'nonce' | 'none';
  available(ctx: Context): boolean | Promise<boolean>;
  unavailableReason?(ctx: Context): string | undefined | Promise<string | undefined>;
  /** A race that prevents all transport is a skip, not a failed nonce. */
  wake(ctx: Context, line: string): void | 'skipped' | Promise<void | 'skipped'>;
}
