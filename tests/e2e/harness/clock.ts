// Scenario clocks. Every owner process keeps its own clock: fake clocks advance only
// when a test advances them, and live clocks report monotonic elapsed time plus
// wall-clock provenance. Readings from different clocks are never subtracted.

export type ClockSource = 'fake' | 'monotonic';

export interface ScenarioClock {
  readonly id: string;
  readonly source: ClockSource;
  /** Elapsed milliseconds on this clock only. */
  now(): number;
  /** Wall-clock provenance for live readings; fake clocks have none. */
  wallClock(): string | null;
}

export interface FakeClock extends ScenarioClock {
  readonly source: 'fake';
  /** Resolves once this clock has advanced `ms` past the current reading. */
  sleep(ms: number): Promise<void>;
  /** Moves this clock forward, running due timers in (time, registration) order. */
  advance(ms: number): Promise<void>;
  /** Timers not yet due. */
  pending(): number;
}

export type ClockReading = Readonly<{ clockId: string; at: number }>;

export class CrossClockComparison extends Error {
  constructor(a: string, b: string) {
    super(`refusing to compare readings from independent clocks ${a} and ${b}`);
    this.name = 'CrossClockComparison';
  }
}

function nonNegative(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`clock durations must be finite and non-negative: ${ms}`);
  return ms;
}

export function createFakeClock(id: string, startMs = 0): FakeClock {
  let now = nonNegative(startMs);
  let sequence = 0;
  const timers: { at: number; seq: number; resolve: () => void }[] = [];

  return {
    id,
    source: 'fake',
    now: () => now,
    wallClock: () => null,
    pending: () => timers.length,
    sleep(ms) {
      const at = now + nonNegative(ms);
      return new Promise(resolve => {
        timers.push({ at, seq: sequence++, resolve });
      });
    },
    async advance(ms) {
      const target = now + nonNegative(ms);
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
        const next = timers[0];
        if (!next || next.at > target) break;
        timers.shift();
        now = next.at;
        next.resolve();
        // Let the woken continuation run (and register follow-up timers) before
        // the next due timer fires.
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      now = target;
    },
  };
}

export function createMonotonicClock(id: string): ScenarioClock {
  const origin = performance.now();
  return {
    id,
    source: 'monotonic',
    now: () => performance.now() - origin,
    wallClock: () => new Date().toISOString(),
  };
}

/** Duration between two readings of the same clock. */
export function elapsed(from: ClockReading, to: ClockReading): number {
  if (from.clockId !== to.clockId) throw new CrossClockComparison(from.clockId, to.clockId);
  return to.at - from.at;
}
