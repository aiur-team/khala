// Explicit operation outcomes shared by every effectful messaging port.

/**
 * Result of an operation that may have remote effects.
 *
 * - `rejected`: the owner refused the operation; `code` is a finite public code.
 * - `unavailable`: the operation was not performed and may be retried as-is.
 * - `outcome_unknown`: the operation may or may not have taken effect. Callers keep
 *   the `operationId` and resolve it; they never retry with new bytes. Aborting a
 *   local wait produces this, not a cancellation.
 */
export type OperationResult<T, Code extends string = string> =
  | Readonly<{ kind: 'ok'; value: T }>
  | Readonly<{ kind: 'rejected'; code: Code }>
  | Readonly<{ kind: 'unavailable'; retryable: true }>
  | Readonly<{ kind: 'outcome_unknown'; operationId: string }>;

export const ok = <T>(value: T): OperationResult<T, never> => ({ kind: 'ok', value });
export const rejected = <Code extends string>(code: Code): OperationResult<never, Code> => ({ kind: 'rejected', code });
export const unavailable = (): OperationResult<never, never> => ({ kind: 'unavailable', retryable: true });
export const outcomeUnknown = (operationId: string): OperationResult<never, never> => ({ kind: 'outcome_unknown', operationId });

/** Options accepted by every asynchronous port operation. */
export type CallOptions = Readonly<{ signal?: AbortSignal }>;

/** Releases an observer registration. Calling it more than once is harmless. */
export type Disposer = () => void;

/**
 * Notifications carry the client lifecycle generation that produced them, so an
 * old account or session cannot update state owned by its replacement.
 */
export type GenerationTagged = Readonly<{ generation: number }>;

/** True only for notifications from the consumer's current lifecycle generation. */
export function isCurrentGeneration(current: number, notification: GenerationTagged): boolean {
  return notification.generation === current;
}
