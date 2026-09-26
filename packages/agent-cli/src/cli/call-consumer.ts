import { CliError } from './errors.js';
import type { BatchInbox, InboxConsumer } from './inbox.js';

/** How long one call waits for another short-lived consumer to release the listener lock. */
export const CALL_LISTENER_WAIT_MS = 2_000;
const RETRY_MS = 20;

export type CallConsumerOptions = Readonly<{
  waitMs?: number;
  signal?: AbortSignal | undefined;
  /** Marks every selection as the agent's own Khala call, so native hooks do not repeat it this turn. */
  explicitRead?: boolean;
}>;

/**
 * Acquires the existing single-consumer listener lock, retrying only while another
 * consumer holds it and at most for `waitMs`. Every other failure is immediate.
 */
export async function acquireListenerWithin(
  inbox: BatchInbox,
  options: CallConsumerOptions = {},
): Promise<InboxConsumer> {
  const deadline = Date.now() + (options.waitMs ?? CALL_LISTENER_WAIT_MS);
  while (true) {
    try {
      return await inbox.acquireListener();
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== 'listener_busy'
        || options.signal?.aborted || Date.now() + RETRY_MS > deadline) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, RETRY_MS));
  }
}

/**
 * A consumer that holds the listener lock only for each selection. Long-lived
 * processes such as `mcp-serve` use it so native hooks and explicit CLI reads for
 * the same binding can take their turn between calls. Selection, acknowledgement
 * and staging stay atomic inside the one locked `readBatch`.
 */
export function callScopedConsumer(inbox: BatchInbox, options: CallConsumerOptions = {}): InboxConsumer {
  return {
    async readBatch(input) {
      const consumer = await acquireListenerWithin(inbox, options);
      try {
        return await consumer.readBatch(options.explicitRead === true ? { ...input, explicitRead: true } : input);
      } finally {
        await consumer.release();
      }
    },
    async release() {},
  };
}
