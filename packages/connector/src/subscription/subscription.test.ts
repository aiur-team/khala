import { describe, expect, it } from 'vitest';
import type { EventRef, SessionBinding } from '@khala/contracts/delivery/index';
import {
  type DeviceId, type EventId, type ParticipantId, type RoomId, digestMessageContent, encodeMessageContent,
} from '@khala/contracts/messaging/index';
import {
  type AcceptResult, type AuthorityCheck, type CursorCommit, type SourceEvent, type SourceListener, type SourceRead,
  type SubscriptionHandle, type SubscriptionPorts, type SubscriptionState, startSubscription,
} from './index';

const ROOM = 'room-1' as RoomId;
const ALICE = 'participant-alice' as ParticipantId;
const ALICE_DEVICE = 'device-alice' as DeviceId;
const MALLORY = 'participant-mallory' as ParticipantId;
const MALLORY_DEVICE = 'device-mallory' as DeviceId;
const SECRET = 'pending secret text';

const binding: SessionBinding = {
  v: 1,
  bindingId: 'binding-1' as SessionBinding['bindingId'],
  ownerId: 'owner-bob' as SessionBinding['ownerId'],
  agentParticipantId: 'participant-bob-agent' as ParticipantId,
  deviceId: 'device-bob-connector' as DeviceId,
  harness: 'claude',
  sessionId: 'session-1',
  generation: 1,
};

async function decrypted(n: number, overrides: Partial<{ verifiedDeviceId: DeviceId; body: string }> = {}): Promise<SourceEvent> {
  const content = { v: 1 as const, kind: 'text' as const, body: overrides.body ?? `${SECRET} ${n}` };
  const digest = await digestMessageContent(content);
  if (!digest.ok) throw new Error('digest');
  const ref: EventRef = {
    v: 1, roomId: ROOM, eventId: `E${n}` as EventId, authorParticipantId: ALICE, authorDeviceId: ALICE_DEVICE,
    contentDigest: digest.digest,
  };
  return { kind: 'decrypted', ref, verifiedDeviceId: overrides.verifiedDeviceId ?? ALICE_DEVICE, canonicalPayload: encodeMessageContent(content) };
}

function missingKeys(n: number): SourceEvent {
  return {
    kind: 'undecryptable',
    ref: { v: 1, roomId: ROOM, eventId: `E${n}` as EventId, authorParticipantId: ALICE, authorDeviceId: ALICE_DEVICE },
    reason: 'missing_keys',
  };
}

/** Durable source whose cursors are `c<count>`: an opaque string to the subscription. */
class FakeSource {
  log: SourceEvent[] = [];
  retainedFrom = 0;
  authority: AuthorityCheck = 'ok';
  authorizeCalls = 0;
  reads: (string | null)[] = [];
  failReads: Array<'unavailable' | 'throw' | 'hang' | Readonly<{ kind: 'rejected'; code: 'authority_lost' | 'unsupported' }>> = [];
  listeners: Array<{ listener: SourceListener; disposed: boolean }> = [];

  authorize(): Promise<AuthorityCheck> {
    this.authorizeCalls += 1;
    return Promise.resolve(this.authority);
  }

  listen(listener: SourceListener) {
    const entry = { listener, disposed: false };
    this.listeners.push(entry);
    return () => {
      entry.disposed = true;
    };
  }

  read(input: Readonly<{ cursor: string | null; limit: number }>, options?: Readonly<{ signal?: AbortSignal }>): Promise<SourceRead> {
    this.reads.push(input.cursor);
    const failure = this.failReads.shift();
    if (failure === 'throw') return Promise.reject(new Error('socket reset'));
    if (failure === 'unavailable') return Promise.resolve({ kind: 'unavailable' });
    if (failure === 'hang') {
      return new Promise(resolve => options?.signal?.addEventListener('abort', () => resolve({ kind: 'unavailable' })));
    }
    if (failure) return Promise.resolve(failure);
    const from = input.cursor === null ? 0 : Number(input.cursor.slice(1));
    if (from < this.retainedFrom) return Promise.resolve({ kind: 'gap' });
    const events = this.log.slice(from, from + input.limit);
    const next = from + events.length;
    return Promise.resolve({ kind: 'page', events, nextCursor: `c${next}`, caughtUp: next === this.log.length });
  }

  /** Delivers to live listeners only, as a real SDK would. */
  hint(): void {
    for (const entry of this.listeners) if (!entry.disposed) entry.listener.hint();
  }

  lose(): void {
    for (const entry of this.listeners) if (!entry.disposed) entry.listener.lost();
  }
}

class FakeStore {
  pending = new Map<string, string>();
  unavailable = new Map<string, string>();
  unavailableAuthors = new Map<string, string>();
  accepts: Array<{ eventId: string; result: AcceptResult }> = [];
  failAccept: Array<'throw' | 'blocked'> = [];
  onAccept: ((eventId: string) => void) | null = null;
  cursor: string | null = null;
  revision = 0;
  commits: string[] = [];
  failCommit: Array<'failed' | 'conflict' | 'throw'> = [];
  lockBusy = 0;
  lockHeld = false;

  readonly ingestion = {
    accept: async (input: Readonly<{ binding: SessionBinding; event: EventRef; canonicalPayload: Uint8Array }>): Promise<AcceptResult> => {
      const failure = this.failAccept.shift();
      if (failure === 'throw') throw new Error('disk full');
      const { eventId, contentDigest } = input.event;
      let result: AcceptResult = failure ?? 'stored';
      if (!failure) {
        const known = this.pending.get(eventId);
        result = known === undefined ? 'stored' : known === contentDigest ? 'duplicate' : 'blocked';
        if (result === 'stored') this.pending.set(eventId, contentDigest);
      }
      this.accepts.push({ eventId, result });
      this.onAccept?.(eventId);
      return result;
    },
    acceptUnavailable: async (input: Readonly<{ ref: { eventId: string; authorParticipantId: string; authorDeviceId: string }; reason: string }>): Promise<AcceptResult> => {
      const known = this.unavailable.has(input.ref.eventId);
      this.unavailableAuthors.set(input.ref.eventId, `${input.ref.authorParticipantId}/${input.ref.authorDeviceId}`);
      this.unavailable.set(input.ref.eventId, input.reason);
      return known ? 'duplicate' : 'stored';
    },
  };

  readonly cursors = {
    load: async () => ({ kind: 'loaded' as const, cursor: this.cursor, revision: this.revision }),
    commit: async (input: Readonly<{ streamId: string; expectedRevision: number; opaqueCursor: string }>): Promise<CursorCommit> => {
      const failure = this.failCommit.shift();
      if (failure === 'throw') throw new Error('io');
      if (failure) return { kind: failure };
      if (input.expectedRevision !== this.revision) return { kind: 'conflict' };
      this.revision += 1;
      this.cursor = input.opaqueCursor;
      this.commits.push(input.opaqueCursor);
      return { kind: 'committed', revision: this.revision };
    },
  };

  readonly lock = {
    acquire: async () => {
      if (this.lockBusy > 0) {
        this.lockBusy -= 1;
        return { kind: 'busy' as const };
      }
      this.lockHeld = true;
      return { kind: 'held' as const, release: async () => { this.lockHeld = false; } };
    },
  };
}

class FakeScheduler {
  time = Date.UTC(2026, 8, 18);
  timers: Array<{ at: number; run: () => void; cleared: boolean }> = [];
  readonly scheduler = {
    now: () => this.time,
    setTimer: (delayMs: number, run: () => void) => {
      const timer = { at: this.time + delayMs, run, cleared: false };
      this.timers.push(timer);
      return () => {
        timer.cleared = true;
      };
    },
  };

  active() {
    return this.timers.filter(timer => !timer.cleared);
  }

  async advance(ms: number): Promise<void> {
    this.time += ms;
    for (const timer of this.active().filter(t => t.at <= this.time)) {
      timer.cleared = true;
      timer.run();
    }
    await settle();
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve));
}

type Harness = {
  source: FakeSource;
  store: FakeStore;
  clock: FakeScheduler;
  states: SubscriptionState[];
  provenance: { unavailable: number; observerThrows?: boolean };
  handle: SubscriptionHandle;
};

async function start(setup: (h: Omit<Harness, 'handle' | 'states'>) => void | Promise<void> = () => undefined, pageSize = 50): Promise<Harness> {
  const source = new FakeSource();
  const store = new FakeStore();
  const clock = new FakeScheduler();
  const provenance: Harness['provenance'] = { unavailable: 0 };
  await setup({ source, store, clock, provenance });
  const states: SubscriptionState[] = [];
  const ports: SubscriptionPorts = {
    source,
    cursors: store.cursors,
    ingestion: store.ingestion,
    provenance: {
      participantForDevice: async ({ deviceId }) => {
        if (provenance.unavailable > 0) {
          provenance.unavailable -= 1;
          return 'unavailable';
        }
        return deviceId === ALICE_DEVICE ? ALICE : deviceId === MALLORY_DEVICE ? MALLORY : null;
      },
    },
    lock: store.lock,
    scheduler: clock.scheduler,
    random: () => 0.5,
    onState: state => {
      states.push(state);
      if (provenance.observerThrows) throw new Error('observer');
    },
  };
  const handle = await startSubscription({ binding, streamId: 'stream-1', pageSize, retry: { baseMs: 1_000, maxMs: 8_000 } }, ports);
  await settle();
  return { source, store, clock, states, provenance, handle };
}

/** Seeds E1..En as already stored and committed at `c<n>`. */
async function committedThrough(h: Omit<Harness, 'handle' | 'states'>, n: number): Promise<void> {
  for (let i = 1; i <= n; i += 1) {
    const event = await decrypted(i);
    h.source.log.push(event);
    if (event.kind === 'decrypted') h.store.pending.set(event.ref.eventId, event.ref.contentDigest);
  }
  h.store.cursor = `c${n}`;
  h.store.revision = n;
}

describe('startSubscription', () => {
  it('catches up from the committed cursor, stores before committing, then goes live', async () => {
    const h = await start(async s => {
      await committedThrough(s, 2);
      s.source.log.push(await decrypted(3), await decrypted(4));
    });
    expect(h.source.reads[0]).toBe('c2');
    expect(h.store.accepts.map(a => a.eventId)).toEqual(['E3', 'E4']);
    expect(h.store.cursor).toBe('c4');
    expect(h.states.map(s => s.kind)).toEqual(['catching_up', 'live']);
    expect(h.handle.state()).toEqual({ kind: 'live', streamId: 'stream-1' });
    expect(h.store.lockHeld).toBe(true);
  });

  it('pages through a long backlog, committing each page', async () => {
    const h = await start(async s => {
      for (let i = 1; i <= 5; i += 1) s.source.log.push(await decrypted(i));
    }, 2);
    expect(h.store.commits).toEqual(['c2', 'c4', 'c5']);
    expect(h.handle.state().kind).toBe('live');
  });

  it('reads the durable source again on a live hint and coalesces hints', async () => {
    const h = await start(async s => committedThrough(s, 1));
    h.source.log.push(await decrypted(2));
    h.source.hint();
    h.source.hint();
    h.source.hint();
    await settle();
    expect(h.store.accepts.map(a => a.eventId)).toEqual(['E2']);
    expect(h.source.reads.length).toBeLessThanOrEqual(3);
    expect(h.store.cursor).toBe('c2');
  });

  it('AE1: a disconnect covering two events yields each review item once after recovery', async () => {
    const h = await start(async s => committedThrough(s, 7));
    // E8 is durably stored, then the connection drops before C8 can commit.
    h.store.onAccept = eventId => {
      if (eventId === 'E8') h.source.lose();
    };
    h.source.log.push(await decrypted(8));
    h.source.hint();
    await settle();
    h.store.onAccept = null;
    expect(h.store.cursor).toBe('c7');
    expect(h.handle.state().kind).toBe('offline');

    h.source.log.push(await decrypted(9));
    await h.clock.advance(8_000);

    expect(h.source.authorizeCalls).toBe(2);
    expect(h.store.accepts).toEqual([
      { eventId: 'E8', result: 'stored' },
      { eventId: 'E8', result: 'duplicate' },
      { eventId: 'E9', result: 'stored' },
    ]);
    expect([...h.store.pending.keys()].filter(id => id === 'E8' || id === 'E9')).toEqual(['E8', 'E9']);
    expect(h.store.cursor).toBe('c9');
    expect(h.handle.state().kind).toBe('live');
  });

  it('AE2: a delayed decrypt stays blocked and retryable and never hides behind an advanced cursor', async () => {
    const h = await start(async s => {
      await committedThrough(s, 7);
      s.source.log.push(missingKeys(8), await decrypted(9));
    });
    expect(h.handle.state()).toEqual({ kind: 'blocked', code: 'missing_keys' });
    expect(h.store.cursor).toBe('c7');
    expect(h.store.accepts).toEqual([]);

    // Timer retries while keys are still missing keep the cursor held.
    await h.clock.advance(8_000);
    expect(h.handle.state()).toEqual({ kind: 'blocked', code: 'missing_keys' });
    expect(h.store.cursor).toBe('c7');

    // The room key arrives; the SDK hints and the event now decrypts.
    h.source.log[7] = await decrypted(8);
    h.source.hint();
    await settle();
    expect(h.store.accepts.map(a => a.eventId)).toEqual(['E8', 'E9']);
    expect(h.store.cursor).toBe('c9');
    expect(h.handle.state().kind).toBe('live');
  });

  it('reconnects when the connection drops while blocked on missing keys', async () => {
    const h = await start(async s => {
      await committedThrough(s, 1);
      s.source.log.push(missingKeys(2));
    });
    expect(h.handle.state()).toEqual({ kind: 'blocked', code: 'missing_keys' });
    h.source.lose();
    await settle();
    expect(h.handle.state().kind).toBe('offline');
    expect(h.clock.active()).toHaveLength(1);

    h.source.log[1] = await decrypted(2);
    await h.clock.advance(8_000);
    expect(h.source.authorizeCalls).toBe(2);
    expect(h.store.cursor).toBe('c2');
    expect(h.handle.state().kind).toBe('live');
  });

  it('keeps a cursor commit that lands after the connection was superseded', async () => {
    const h = await start(async s => committedThrough(s, 1));
    const commit = h.store.cursors.commit;
    h.store.cursors.commit = async input => {
      h.source.lose();
      return commit(input);
    };
    h.source.log.push(await decrypted(2));
    h.source.hint();
    await settle();
    h.store.cursors.commit = commit;
    expect(h.store.cursor).toBe('c2');
    await h.clock.advance(8_000);
    expect(h.source.reads.at(-1)).toBe('c2');
    expect(h.states.some(s => s.kind === 'blocked')).toBe(false);
    expect(h.handle.state().kind).toBe('live');
  });

  it('survives a throwing state observer and still releases the lock on stop', async () => {
    const h = await start(async s => {
      await committedThrough(s, 1);
      s.provenance.observerThrows = true;
    });
    expect(h.handle.state().kind).toBe('live');
    h.source.lose();
    await h.clock.advance(8_000);
    expect(h.handle.state().kind).toBe('live');
    await h.handle.stop();
    expect(h.store.lockHeld).toBe(false);
  });

  it('ignores callbacks from a superseded connection', async () => {
    const h = await start(async s => committedThrough(s, 1));
    const [old] = h.source.listeners;
    h.source.lose();
    await settle();
    await h.clock.advance(8_000);
    expect(h.handle.state().kind).toBe('live');
    const authorized = h.source.authorizeCalls;
    const reads = h.source.reads.length;

    old!.listener.lost();
    old!.listener.hint();
    await settle();
    expect(h.handle.state().kind).toBe('live');
    expect(h.source.authorizeCalls).toBe(authorized);
    expect(h.source.reads.length).toBe(reads);
    expect(h.clock.active()).toEqual([]);
  });

  it('reports a replay gap and never labels the stream live or retries past it', async () => {
    const h = await start(async s => {
      await committedThrough(s, 3);
      s.source.retainedFrom = 5;
    });
    expect(h.handle.state()).toEqual({ kind: 'blocked', code: 'replay_gap' });
    expect(h.states.some(s => s.kind === 'live')).toBe(false);
    expect(h.store.cursor).toBe('c3');
    expect(h.clock.active()).toEqual([]);
  });

  it('rechecks authority on reconnect and blocks a revoked device while offline', async () => {
    const h = await start(async s => committedThrough(s, 1));
    h.source.authority = 'revoked';
    h.source.lose();
    h.source.log.push(await decrypted(2));
    await h.clock.advance(8_000);
    expect(h.handle.state()).toEqual({ kind: 'blocked', code: 'authority_lost' });
    expect(h.store.accepts).toEqual([]);
    expect(h.clock.active()).toEqual([]);
    expect(h.source.listeners.every(l => l.disposed)).toBe(true);
  });

  it.each([
    ['authority_lost', { kind: 'rejected', code: 'authority_lost' }],
    ['unsupported', { kind: 'rejected', code: 'unsupported' }],
  ] as const)('blocks terminally when the source rejects with %s', async (code, rejection) => {
    const h = await start(s => {
      s.source.failReads.push(rejection);
    });
    expect(h.handle.state()).toEqual({ kind: 'blocked', code });
    expect(h.clock.active()).toEqual([]);
  });

  it('blocks on storage failure without advancing, then retries from the same cursor', async () => {
    const h = await start(async s => {
      await committedThrough(s, 1);
      s.source.log.push(await decrypted(2));
      s.store.failAccept.push('throw');
    });
    expect(h.handle.state()).toEqual({ kind: 'blocked', code: 'storage_failed' });
    expect(h.store.cursor).toBe('c1');

    await h.clock.advance(8_000);
    expect(h.store.cursor).toBe('c2');
    expect(h.handle.state().kind).toBe('live');
  });

  it('blocks when the store refuses a changed digest under a known event ID', async () => {
    const h = await start(async s => {
      await committedThrough(s, 1);
      s.store.pending.set('E2', `sha256:${'0'.repeat(64)}`);
      s.source.log.push(await decrypted(2));
    });
    expect(h.store.accepts).toEqual([{ eventId: 'E2', result: 'blocked' }]);
    expect(h.handle.state()).toEqual({ kind: 'blocked', code: 'storage_failed' });
    expect(h.store.cursor).toBe('c1');
  });

  it.each(['failed', 'conflict', 'throw'] as const)('reloads the durable cursor when a commit reports %s', async failure => {
    const h = await start(async s => {
      s.source.log.push(await decrypted(1));
      s.store.failCommit.push(failure);
    });
    expect(h.handle.state()).toEqual({ kind: 'blocked', code: 'storage_failed' });
    expect(h.store.cursor).toBe(null);

    await h.clock.advance(8_000);
    expect(h.store.accepts).toEqual([{ eventId: 'E1', result: 'stored' }, { eventId: 'E1', result: 'duplicate' }]);
    expect(h.store.cursor).toBe('c1');
    expect(h.handle.state().kind).toBe('live');
  });

  it('attributes content forged by a participant to its verified sender, never the claimed author', async () => {
    const h = await start(async s => {
      s.source.log.push(
        await decrypted(1, { verifiedDeviceId: MALLORY_DEVICE }),
        await decrypted(2),
      );
    });
    expect(h.store.unavailable.get('E1')).toBe('decrypt_failed');
    expect(h.store.unavailableAuthors.get('E1')).toBe(`${MALLORY}/${MALLORY_DEVICE}`);
    expect(h.store.pending.has('E1')).toBe(false);
    expect(h.store.pending.has('E2')).toBe(true);
    expect(h.store.cursor).toBe('c2');
  });

  it('drops content from a device that is not a room participant and keeps going', async () => {
    const h = await start(async s => {
      s.source.log.push(
        await decrypted(1, { verifiedDeviceId: 'device-stranger' as DeviceId }),
        await decrypted(2),
      );
    });
    expect(h.store.unavailable.has('E1')).toBe(false);
    expect(h.store.pending.has('E1')).toBe(false);
    expect(h.store.pending.has('E2')).toBe(true);
    expect(h.store.cursor).toBe('c2');
  });

  it('records a payload that does not match its digest as unavailable', async () => {
    const h = await start(async s => {
      const event = await decrypted(1);
      if (event.kind !== 'decrypted') throw new Error('fixture');
      s.source.log.push({ ...event, canonicalPayload: encodeMessageContent({ v: 1, kind: 'text', body: 'swapped' }) });
    });
    expect(h.store.unavailable.get('E1')).toBe('decrypt_failed');
    expect(h.store.accepts).toEqual([]);
  });

  it('records final decryption failures durably instead of stalling the stream', async () => {
    const h = await start(async s => {
      s.source.log.push(
        { kind: 'undecryptable', ref: { v: 1, roomId: ROOM, eventId: 'E1' as EventId, authorParticipantId: ALICE, authorDeviceId: ALICE_DEVICE }, reason: 'withheld' },
        await decrypted(2),
      );
    });
    expect(h.store.unavailable.get('E1')).toBe('withheld');
    expect(h.store.cursor).toBe('c2');
  });

  it('retries a provenance lookup outage with backoff', async () => {
    const h = await start(async s => {
      s.source.log.push(await decrypted(1));
      s.provenance.unavailable = 1;
    });
    expect(h.handle.state().kind).toBe('offline');
    expect(h.store.cursor).toBe(null);
    await h.clock.advance(8_000);
    expect(h.store.cursor).toBe('c1');
  });

  it('goes offline with a bounded, jittered retry time on transport outage', async () => {
    const h = await start(s => {
      s.source.failReads.push('throw', 'unavailable');
    });
    // random 0.5 of a 1s then 2s ceiling.
    expect(h.handle.state()).toEqual({ kind: 'offline', retryAt: new Date(h.clock.time + 500).toISOString() });
    await h.clock.advance(500);
    expect(h.handle.state()).toEqual({ kind: 'offline', retryAt: new Date(h.clock.time + 1_000).toISOString() });
    await h.clock.advance(1_000);
    expect(h.handle.state().kind).toBe('live');
    expect(h.source.authorizeCalls).toBe(3);
  });

  it('waits for the device lock rather than sharing device state', async () => {
    const h = await start(s => {
      s.store.lockBusy = 1;
    });
    expect(h.handle.state()).toEqual({ kind: 'blocked', code: 'storage_failed' });
    expect(h.source.authorizeCalls).toBe(0);
    await h.clock.advance(8_000);
    expect(h.handle.state().kind).toBe('live');
  });

  it('stop cancels in-flight reads, retries and reception, then releases the lock', async () => {
    const h = await start(s => {
      s.source.failReads.push('hang');
    });
    expect(h.handle.state().kind).toBe('catching_up');
    await h.handle.stop();
    await h.handle.stop();
    expect(h.handle.state()).toEqual({ kind: 'offline', retryAt: null });
    expect(h.store.lockHeld).toBe(false);
    expect(h.clock.active()).toEqual([]);
    expect(h.source.listeners.every(l => l.disposed)).toBe(true);

    h.source.log.push(await decrypted(1));
    await h.clock.advance(60_000);
    expect(h.store.accepts).toEqual([]);
  });

  it('stop during a pending reconnect prevents it', async () => {
    const h = await start(s => {
      s.source.failReads.push('unavailable');
    });
    expect(h.clock.active()).toHaveLength(1);
    await h.handle.stop();
    await h.clock.advance(60_000);
    expect(h.source.authorizeCalls).toBe(1);
  });

  it('never exposes pending content, counts or senders through readiness or hints', async () => {
    const h = await start(async s => {
      await committedThrough(s, 2);
      s.source.log.push(missingKeys(3));
    });
    h.source.log[2] = await decrypted(3);
    h.source.hint();
    await settle();
    const exposed = JSON.stringify(h.states);
    expect(exposed).not.toContain(SECRET);
    expect(exposed).not.toContain(ALICE);
    expect(exposed).not.toContain('E3');
    for (const state of h.states) {
      expect(Object.keys(state).sort()).toEqual(state.kind === 'blocked' ? ['code', 'kind'] : state.kind === 'offline' ? ['kind', 'retryAt'] : ['kind', 'streamId']);
    }
    expect(h.source.listeners[0]!.listener.hint.length).toBe(0);
  });
});
