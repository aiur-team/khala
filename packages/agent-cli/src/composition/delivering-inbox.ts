import type { BatchInbox } from '../cli/inbox.js';
import type { HeldGeneration, InternalDelivery } from './internal-delivery.js';

// Kept apart from `internal-delivery.ts` so the CLI entry can wrap its inbox
// without loading the descriptor client until `--internal-descriptor` is given.

export type DeliveringInbox = Readonly<{
  /** Opens the inbox only after one pull for that exact generation, then keeps pulling. */
  inbox: (bindingId: string, generation: number) => Promise<BatchInbox>;
  /** Ends every background pull; resolves once none is running. */
  stop(): Promise<void>;
}>;

/**
 * Wraps a command's inbox factory so the first open of a binding generation pulls
 * first (a `khala read` sees a message already released), then pulls again every
 * `intervalMs` for as long as the command runs (`listen`, `mcp-serve`). A pull that
 * reports the binding revoked ends that generation's loop for good.
 */
export function deliveringInbox(
  open: (bindingId: string, generation: number) => Promise<BatchInbox>,
  delivery: InternalDelivery,
  options: Readonly<{ signal?: AbortSignal; intervalMs?: number }> = {},
): DeliveringInbox {
  const intervalMs = options.intervalMs ?? 1_000;
  const stopping = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, stopping.signal]) : stopping.signal;
  const loops = new Map<string, Promise<void>>();

  async function loop(held: HeldGeneration, openHeld: () => Promise<BatchInbox>): Promise<void> {
    while (!signal.aborted) {
      await pause(intervalMs, signal);
      if (signal.aborted) return;
      if (await delivery.pull(held, openHeld, signal) === 'revoked') return;
    }
  }

  return {
    async inbox(bindingId, generation) {
      const held = { bindingId, generation };
      const openHeld = () => open(bindingId, generation);
      const key = JSON.stringify([bindingId, generation]);
      if (!loops.has(key) && !signal.aborted) {
        const first = await delivery.pull(held, openHeld, signal);
        if (first !== 'revoked') loops.set(key, loop(held, openHeld));
      }
      return openHeld();
    },
    async stop() {
      stopping.abort();
      await Promise.all(loops.values());
    },
  };
}

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener('abort', done, { once: true });
  });
}
