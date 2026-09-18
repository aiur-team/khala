// Live encrypted subscription with durable catch-up for one owner connector.
//
// Each connection generation rechecks authority, attaches live reception, then
// replays from the committed cursor. A page's cursor is committed only after
// every event in it is durably handled, so a crash or reconnect replays into
// deduplication instead of loss. Live hints only wake a durable read; they carry
// no content and coalesce into one pending wake. Nothing here notifies a model:
// released work is dispatched elsewhere, and state exposes readiness only.

import type { SessionBinding } from '@khala/contracts/delivery/index';
import type { Disposer } from '@khala/contracts/messaging/index';
import type { SourceRead, SubscriptionSource } from './adapter';
import { type EventIngestionPort, type ProvenancePort, ingestPage } from './ingest';
import {
  type BlockedCode, type RetryPolicy, type SubscriptionState, DEFAULT_RETRY, Generation, TERMINAL_BLOCKS, backoffDelay,
} from './state';

export type { AuthorityCheck, SourceEvent, SourceListener, SourceRead, SubscriptionSource } from './adapter';
export type { AcceptResult, EventIngestionPort, ProvenancePort } from './ingest';
export type { BlockedCode, RetryPolicy, SubscriptionState } from './state';
export { DEFAULT_RETRY, backoffDelay } from './state';

export type CursorLoad = Readonly<{ kind: 'loaded'; cursor: string | null; revision: number }> | Readonly<{ kind: 'failed' }>;

export type CursorCommit =
  | Readonly<{ kind: 'committed'; revision: number }>
  | Readonly<{ kind: 'conflict' }>
  | Readonly<{ kind: 'failed' }>;

/** Durable per-stream application cursor (KHA-115). Commit is compare-and-set on `expectedRevision`. */
export interface CursorStore {
  load(streamId: string): Promise<CursorLoad>;
  commit(input: Readonly<{ streamId: string; expectedRevision: number; opaqueCursor: string }>): Promise<CursorCommit>;
}

/** Exclusive single-writer lock on the connector device state (KHA-115). */
export interface DeviceLock {
  acquire(): Promise<Readonly<{ kind: 'held'; release: () => Promise<void> }> | Readonly<{ kind: 'busy' }>>;
}

/** Injected time source so retry and cancellation are testable without real delays. */
export type Scheduler = Readonly<{
  /** Epoch milliseconds. */
  now: () => number;
  setTimer: (delayMs: number, run: () => void) => Disposer;
}>;

export type SubscriptionInput = Readonly<{
  binding: SessionBinding;
  /** Stream identity under which the cursor is stored; surfaced in readiness states. */
  streamId: string;
  pageSize?: number;
  retry?: RetryPolicy;
}>;

export type SubscriptionPorts = Readonly<{
  source: SubscriptionSource;
  cursors: CursorStore;
  ingestion: EventIngestionPort;
  provenance: ProvenancePort;
  lock: DeviceLock;
  scheduler: Scheduler;
  /** Uniform in `[0, 1)`; jitter for backoff. */
  random: () => number;
  /** Readiness observer for runtime status. Receives states only, never event content. */
  onState?: (state: SubscriptionState) => void;
}>;

export interface SubscriptionHandle {
  state(): SubscriptionState;
  /** Cancels reception, retries and in-flight work, then releases the device lock. Idempotent. */
  stop(): Promise<void>;
}

export const DEFAULT_PAGE_SIZE = 50;

export async function startSubscription(input: SubscriptionInput, ports: SubscriptionPorts): Promise<SubscriptionHandle> {
  const subscription = new Subscription(input, ports);
  subscription.begin();
  return { state: () => subscription.current, stop: () => subscription.stop() };
}

type Committed = Readonly<{ cursor: string | null; revision: number }>;

class Subscription {
  current: SubscriptionState;
  readonly #input: SubscriptionInput;
  readonly #ports: SubscriptionPorts;
  readonly #generation = new Generation();
  #lock: Readonly<{ release: () => Promise<void> }> | null = null;
  #committed: Committed | null = null;
  #attempt = 0;
  #stopped = false;
  #running: Promise<void> = Promise.resolve();
  #listener: Disposer | null = null;
  #timer: Disposer | null = null;
  #abort: AbortController | null = null;
  #wake: { pending: boolean; resolve: (() => void) | null } = { pending: false, resolve: null };

  constructor(input: SubscriptionInput, ports: SubscriptionPorts) {
    this.#input = input;
    this.#ports = ports;
    this.current = { kind: 'starting', streamId: input.streamId };
  }

  /** Starts a new connection generation, superseding any earlier one. */
  begin(): void {
    if (this.#stopped) return;
    this.#teardown();
    const generation = this.#generation.next();
    const abort = new AbortController();
    this.#abort = abort;
    // Single flight: a superseded connection finishes (its ports honour the abort
    // signal) before the next one touches the source or the store.
    this.#running = this.#running.then(() => this.#connect(generation, abort.signal)).catch(() => {
      if (this.#generation.isCurrent(generation)) this.#reconnectLater();
    });
  }

  async stop(): Promise<void> {
    if (!this.#stopped) {
      this.#stopped = true;
      this.#generation.next();
      this.#teardown();
      this.#setState({ kind: 'offline', retryAt: null });
    }
    await this.#running;
    const lock = this.#lock;
    this.#lock = null;
    if (lock) await lock.release().catch(() => undefined);
  }

  async #connect(generation: number, signal: AbortSignal): Promise<void> {
    const live = () => this.#generation.isCurrent(generation);
    if (!live()) return;

    if (!this.#lock) {
      const lock = await this.#ports.lock.acquire().catch(() => ({ kind: 'busy' as const }));
      if (!live()) {
        if (lock.kind === 'held') await lock.release().catch(() => undefined);
        return;
      }
      if (lock.kind === 'busy') return this.#blockThenRetry('storage_failed');
      this.#lock = lock;
    }

    if (!this.#committed) {
      const loaded = await this.#ports.cursors.load(this.#input.streamId).catch((): CursorLoad => ({ kind: 'failed' }));
      if (!live()) return;
      if (loaded.kind === 'failed') return this.#blockThenRetry('storage_failed');
      this.#committed = { cursor: loaded.cursor, revision: loaded.revision };
    }

    const authority = await this.#ports.source.authorize({ signal }).catch(() => 'unavailable' as const);
    if (!live()) return;
    if (authority === 'revoked' || authority === 'expired') return this.#block('authority_lost');
    if (authority === 'unavailable') return this.#reconnectLater();

    // Subscribe first, then replay: anything arriving during catch-up leaves a wake behind.
    const dispose = this.#ports.source.listen({
      hint: () => {
        if (live()) this.#signalWake();
      },
      lost: () => {
        if (live()) this.#reconnectLater();
      },
    });
    // A connection lost while attaching has already been superseded.
    if (!live()) return dispose();
    this.#listener = dispose;
    if (this.current.kind !== 'live') this.#setState({ kind: 'catching_up', streamId: this.#input.streamId });
    await this.#pump(generation, signal);
  }

  /** Reads and ingests pages until caught up, then waits for a wake. Exits when the generation ends. */
  async #pump(generation: number, signal: AbortSignal): Promise<void> {
    const live = () => this.#generation.isCurrent(generation);
    while (live()) {
      this.#wake.pending = false;
      const committed = this.#committed!;
      const read = await this.#ports.source
        .read({ cursor: committed.cursor, limit: this.#input.pageSize ?? DEFAULT_PAGE_SIZE }, { signal })
        .catch((): SourceRead => ({ kind: 'unavailable' }));
      if (!live()) return;

      if (read.kind === 'unavailable') return this.#reconnectLater();
      if (read.kind === 'gap') return this.#block('replay_gap');
      if (read.kind === 'rejected') return this.#block(read.code);

      const outcome = await ingestPage({
        binding: this.#input.binding,
        ingestion: this.#ports.ingestion,
        provenance: this.#ports.provenance,
        isCurrent: live,
        signal,
      }, read.events);
      if (outcome.kind === 'cancelled' || !live()) return;
      if (outcome.kind === 'retry') {
        if (!(await this.#retryInPlace(generation, null))) return;
        continue;
      }
      if (outcome.kind === 'blocked') {
        if (TERMINAL_BLOCKS.has(outcome.code)) return this.#block(outcome.code);
        // A hint (for example arriving room keys) or the backoff timer retries from the same cursor.
        if (!(await this.#retryInPlace(generation, outcome.code))) return;
        continue;
      }

      if (read.nextCursor !== committed.cursor) {
        const commit = await this.#ports.cursors
          .commit({ streamId: this.#input.streamId, expectedRevision: committed.revision, opaqueCursor: read.nextCursor })
          .catch((): CursorCommit => ({ kind: 'failed' }));
        if (!live()) return;
        if (commit.kind !== 'committed') {
          // Never advance in-memory authority optimistically: reload the durable cursor on retry.
          this.#committed = null;
          return this.#blockThenRetry('storage_failed');
        }
        this.#committed = { cursor: read.nextCursor, revision: commit.revision };
      }

      this.#attempt = 0;
      if (!read.caughtUp) {
        if (this.current.kind !== 'live') this.#setState({ kind: 'catching_up', streamId: this.#input.streamId });
        continue;
      }
      this.#setState({ kind: 'live', streamId: this.#input.streamId });
      if (!(await this.#waitForWake(generation))) return;
    }
  }

  /**
   * Holds the cursor, advertises why, and waits for a hint or the backoff timer
   * within the same connection. Returns false when the generation ended.
   */
  async #retryInPlace(generation: number, code: BlockedCode | null): Promise<boolean> {
    const delay = this.#nextDelay();
    this.#setState(code ? { kind: 'blocked', code } : { kind: 'offline', retryAt: this.#retryAt(delay) });
    this.#timer = this.#ports.scheduler.setTimer(delay, () => this.#signalWake());
    const woke = await this.#waitForWake(generation);
    this.#clearTimer();
    return woke;
  }

  #waitForWake(generation: number): Promise<boolean> {
    if (!this.#generation.isCurrent(generation)) return Promise.resolve(false);
    if (this.#wake.pending) return Promise.resolve(true);
    return new Promise(resolve => {
      this.#wake.resolve = () => resolve(this.#generation.isCurrent(generation));
    });
  }

  #signalWake(): void {
    this.#wake.pending = true;
    const resolve = this.#wake.resolve;
    this.#wake.resolve = null;
    resolve?.();
  }

  /** Ends this connection and schedules a fresh one, which rechecks authority. */
  #reconnectLater(): void {
    if (this.#stopped) return;
    this.#generation.next();
    this.#teardown();
    const delay = this.#nextDelay();
    this.#setState({ kind: 'offline', retryAt: this.#retryAt(delay) });
    this.#timer = this.#ports.scheduler.setTimer(delay, () => this.begin());
  }

  #blockThenRetry(code: BlockedCode): void {
    if (this.#stopped) return;
    this.#generation.next();
    this.#teardown();
    this.#setState({ kind: 'blocked', code });
    this.#timer = this.#ports.scheduler.setTimer(this.#nextDelay(), () => this.begin());
  }

  /** Terminal: no retry. The owner recovers the stream and starts a new subscription. */
  #block(code: BlockedCode): void {
    this.#generation.next();
    this.#teardown();
    this.#setState({ kind: 'blocked', code });
  }

  #teardown(): void {
    this.#clearTimer();
    this.#listener?.();
    this.#listener = null;
    this.#abort?.abort();
    this.#abort = null;
    this.#wake.pending = false;
    const resolve = this.#wake.resolve;
    this.#wake.resolve = null;
    resolve?.();
  }

  #clearTimer(): void {
    this.#timer?.();
    this.#timer = null;
  }

  #nextDelay(): number {
    const delay = backoffDelay(this.#input.retry ?? DEFAULT_RETRY, this.#attempt, this.#ports.random);
    this.#attempt += 1;
    return delay;
  }

  #retryAt(delayMs: number): string {
    return new Date(this.#ports.scheduler.now() + delayMs).toISOString();
  }

  #setState(state: SubscriptionState): void {
    this.current = state;
    this.#ports.onState?.(state);
  }
}
