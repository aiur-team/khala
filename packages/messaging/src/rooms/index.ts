// RoomPort adapter (KHA-112). Callers get the contract port plus a placeholder-aware
// entries view; the SDK client, journal and device lifecycle stay internal.

import type { AuthPrincipal, ContentLimits, DevicePort, Disposer, ParticipantView, RoomId, RoomPort, RoomSnapshot } from '@khala/contracts/messaging/index';
import type { RoomContext } from './context';
import { createRoom } from './create';
import { prepareIntro, resumeIntro } from './intro';
import type { RoomJournal, SendItem } from './journal';
import { send } from './send';
import type { RoomSubstrate, SubstrateUpdate } from './substrate';
import { type RoomEntriesView, RoomProjection, timeline, toEntry } from './timeline';

export { createMemoryRoomJournal, type RoomJournal } from './journal';
export type {
  AcceptedEvent, CreateLookup, RoomSubstrate, SubstrateEffect, SubstrateEvent, SubstratePage, SubstrateRead, SubstrateUpdate,
} from './substrate';
export type { RoomEntriesView, TimelineEntry } from './timeline';

export type RoomServiceInput = Readonly<{
  /** The authenticated owner. Every command acts on this owner's behalf. */
  principal: AuthPrincipal;
  /** The signed-in participant: the owner's human participant or an agent it delegated. */
  actor: ParticipantView;
  device: DevicePort;
  substrate: RoomSubstrate;
  journal: RoomJournal;
  limits: ContentLimits;
  newId?: () => string;
  /** Trusted local time in epoch milliseconds; defaults to `Date.now`. */
  clock?: () => number;
  /** Receives errors thrown by observers. One failing observer never stops the others or later updates. */
  onListenerError?: (error: unknown) => void;
}>;

export interface RoomService extends RoomPort {
  /** Like `observe`, but includes undecryptable placeholders and unechoed own sends. */
  observeEntries(roomId: RoomId, listener: (view: RoomEntriesView) => void): Disposer;
  /** Ends every observation; later commands return `unavailable`. */
  stop(): void;
}

type Observation = {
  roomId: RoomId;
  /** Lifecycle generation that produced `projection`; a new generation starts from an empty one. */
  generation: number;
  projection: RoomProjection;
  snapshotListeners: Set<(snapshot: RoomSnapshot) => void>;
  entryListeners: Set<(view: RoomEntriesView) => void>;
  dispose: Disposer;
  /** Serialises asynchronous digesting so updates apply in arrival order. */
  queue: Promise<void>;
};

export function createRoomService(input: RoomServiceInput): RoomService {
  if (input.actor.ownerId !== input.principal.ownerId) throw new TypeError('room actor must belong to the authenticated owner');
  const observations = new Map<RoomId, Observation>();
  let stopped = false;
  const generation = () => input.device.current().generation;
  const clock = input.clock ?? (() => Date.now());
  const report = input.onListenerError ?? (() => {});
  const projectionFor = (roomId: RoomId) => new RoomProjection(roomId, input.actor, () => new Date(clock()).toISOString());

  const notify = <T>(listeners: Iterable<(value: T) => void>, value: T) => {
    for (const listener of listeners) {
      try {
        listener(value);
      } catch (error) {
        report(error);
      }
    }
  };

  /**
   * Runs `apply` in arrival order against a projection of the current lifecycle,
   * then publishes. Work queued for an earlier generation or a released
   * observation is dropped, and a failure never blocks later updates.
   */
  const enqueue = (observation: Observation, madeIn: number, apply: (projection: RoomProjection) => Promise<void> | void) => {
    observation.queue = observation.queue
      .then(async () => {
        if (observations.get(observation.roomId) !== observation) return;
        const current = generation();
        if (madeIn !== current) return;
        if (observation.generation !== current) {
          observation.generation = current;
          observation.projection = projectionFor(observation.roomId);
        }
        await apply(observation.projection);
        if (observations.get(observation.roomId) !== observation || generation() !== current) return;
        const snapshot = observation.projection.snapshot(current);
        if (snapshot) notify(observation.snapshotListeners, snapshot);
        notify(observation.entryListeners, observation.projection.entries(current));
      })
      .catch(report);
  };

  const ctx: RoomContext = {
    principal: input.principal,
    actor: input.actor,
    device: input.device,
    substrate: input.substrate,
    journal: input.journal,
    limits: input.limits,
    newId: input.newId ?? (() => globalThis.crypto.randomUUID()),
    clock,
    stopped: () => stopped,
    echo(roomId: RoomId, item: SendItem, madeIn: number) {
      const observation = observations.get(roomId);
      if (observation) enqueue(observation, madeIn, projection => projection.applyLocal(item));
    },
  };

  // An update from an earlier device or account lifecycle never touches the current one.
  const receive = (roomId: RoomId, observation: Observation, update: SubstrateUpdate) => {
    if (update.generation !== generation()) return;
    const entries = Promise.all(update.events.map(event => toEntry(roomId, event)));
    enqueue(observation, update.generation, async projection => {
      const resolved = await entries;
      projection.applyRoom(update.room);
      projection.applyRemote(resolved);
    });
  };

  function register<T>(roomId: RoomId, pick: (observation: Observation) => Set<T>, listener: T): Disposer {
    if (stopped) return () => {};
    let observation = observations.get(roomId);
    if (!observation) {
      const created: Observation = {
        roomId,
        generation: generation(),
        projection: projectionFor(roomId),
        snapshotListeners: new Set(),
        entryListeners: new Set(),
        dispose: () => {},
        queue: Promise.resolve(),
      };
      observations.set(roomId, created);
      created.dispose = input.substrate.subscribe(roomId, update => receive(roomId, created, update));
      observation = created;
    }
    const target = observation;
    pick(target).add(listener);
    return () => {
      pick(target).delete(listener);
      if (target.snapshotListeners.size === 0 && target.entryListeners.size === 0 && observations.get(roomId) === target) {
        observations.delete(roomId);
        target.dispose();
      }
    };
  }

  return {
    create: (request, options) => createRoom(ctx, request, options),
    prepareIntro: (batch, options) => prepareIntro(ctx, batch, options),
    resumeIntro: (batchId, options) => resumeIntro(ctx, batchId, options),
    send: (request, options) => send(ctx, request, options),
    timeline: (request, options) => timeline(ctx, request, options),
    observe: (roomId, listener) => register(roomId, observation => observation.snapshotListeners, listener),
    observeEntries: (roomId, listener) => register(roomId, observation => observation.entryListeners, listener),
    stop() {
      stopped = true;
      for (const observation of observations.values()) observation.dispose();
      observations.clear();
    },
  };
}
