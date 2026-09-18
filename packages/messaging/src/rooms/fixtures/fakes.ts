// Typed fakes for the room tests. They prove module behaviour only, never a
// provider capability. Production code cannot import this directory.

import { createHash } from 'node:crypto';
import {
  type AuthPrincipal, type ContentLimits, type DeviceId, type DevicePort, type DeviceView, type EventId, type MessageContent,
  type OwnerId, type ParticipantId, type ParticipantView, type RoomId, type RoomRejection, type RoomSummary,
  decodeContentLimits,
} from '@khala/contracts/messaging/index';
import { createMemoryRoomJournal, createRoomService, type RoomJournal, type RoomService } from '../index';
import type { AcceptedEvent, CreateLookup, RoomSubstrate, SubstrateEffect, SubstratePage, SubstrateRead, SubstrateUpdate } from '../substrate';

// `digestMessageContent` awaits Node's real `crypto.subtle.digest`, which runs on
// the libuv threadpool and can take longer than a test's fixed settle ticks under
// thread-pool contention (a busy shared CI runner). Swap in a same-algorithm
// digest that resolves on the microtask queue instead, so projection tests never
// race the OS scheduler.
const nativeSubtle = globalThis.crypto.subtle;
Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: {
    ...globalThis.crypto,
    subtle: {
      ...nativeSubtle,
      digest: async (algorithm: string, data: Uint8Array): Promise<ArrayBuffer> => {
        if (algorithm !== 'SHA-256') return nativeSubtle.digest(algorithm, data);
        const hash = createHash('sha256').update(data).digest();
        return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength) as ArrayBuffer;
      },
    },
  },
});

const decoded = decodeContentLimits({ maxBodyBytes: 256, maxDisplayNameBytes: 64, maxRoomTitleBytes: 32 });
if (!decoded.ok) throw new Error('fixture limits');
export const limits: ContentLimits = decoded.value;

export const ownerId = 'owner-1' as OwnerId;
export const deviceId = 'device-1' as DeviceId;

export const principal: AuthPrincipal = {
  v: 1, ownerId, providerIssuer: 'https://issuer.example', providerSubject: 'subject-1',
  verifiedEmail: 'owner@example.com', sessionExpiresAt: '2030-01-01T00:00:00Z',
};

export const human: ParticipantView = { participantId: 'p-human' as ParticipantId, kind: 'human', ownerId, displayName: 'Owner', deviceIds: [deviceId] };
export const agent: ParticipantView = { participantId: 'p-agent' as ParticipantId, kind: 'agent', ownerId, displayName: 'Agent', deviceIds: [deviceId] };

export const text = (body: string): MessageContent => ({ v: 1, kind: 'text', body });

export function fakeDevice(initial: Partial<DeviceView> = {}): DevicePort & { view: DeviceView } {
  const device = {
    view: { deviceId, state: 'ready', generation: 1, reason: null, ...initial } as DeviceView,
    async ensureReady() {
      return { kind: 'ok', value: device.view } as const;
    },
    current: () => device.view,
    observe: () => () => {},
    async stop() {},
  };
  return device;
}

/** How the fake transport treats one send: `lose` accepts the event but loses the response. */
export type SendMode = 'accept' | 'lose' | 'unavailable' | 'throw' | Readonly<{ rejected: RoomRejection }>;
export type CreateMode = 'accept' | 'lose' | 'unavailable' | 'throw' | Readonly<{ rejected: RoomRejection }>;

type Landed = { eventId: EventId; roomId: RoomId; clientTxnId: string; content: MessageContent; deviceId: DeviceId };

export class FakeSubstrate implements RoomSubstrate {
  readonly rooms = new Map<RoomId, RoomSummary>();
  readonly byOperation = new Map<string, RoomSummary>();
  readonly landed: Landed[] = [];
  readonly createCalls: string[] = [];
  readonly sendCalls: Array<{ clientTxnId: string; body: string }> = [];
  readonly listeners = new Map<RoomId, Set<(update: SubstrateUpdate) => void>>();
  createMode: CreateMode = 'accept';
  lookupMode: 'exact' | 'unknown' | 'unavailable' = 'exact';
  sendMode: (clientTxnId: string, attempt: number) => SendMode = () => 'accept';
  page: SubstrateRead<SubstratePage> = { kind: 'done', value: { events: [], nextCursor: null, revision: 'r1' } };
  sendingDevice: DeviceId = deviceId;
  readsThrow = false;
  /** When set, `createRoom` waits for it before answering, so tests can overlap calls. */
  createGate: Promise<void> | null = null;
  private sequence = 0;

  addRoom(room: Partial<RoomSummary> = {}): RoomSummary {
    const summary: RoomSummary = { roomId: `room-${++this.sequence}` as RoomId, title: null, membership: 'joined', revision: '1', ...room };
    this.rooms.set(summary.roomId, summary);
    return summary;
  }

  async createRoom(input: Readonly<{ operationId: string; title: string | null }>): Promise<SubstrateEffect<RoomSummary>> {
    this.createCalls.push(input.operationId);
    if (this.createGate) await this.createGate;
    const mode = this.createMode;
    if (mode === 'unavailable') return { kind: 'unavailable' };
    if (typeof mode === 'object') return { kind: 'rejected', code: mode.rejected };
    const room = this.addRoom({ title: input.title });
    this.byOperation.set(input.operationId, room);
    if (mode === 'throw') throw new Error('socket closed');
    return mode === 'lose' ? { kind: 'unknown' } : { kind: 'done', value: room };
  }

  async findCreatedRoom(input: Readonly<{ operationId: string }>): Promise<CreateLookup> {
    if (this.lookupMode !== 'exact') return { kind: this.lookupMode };
    const room = this.byOperation.get(input.operationId);
    return room ? { kind: 'found', room } : { kind: 'absent' };
  }

  async room(roomId: RoomId): Promise<SubstrateRead<RoomSummary>> {
    if (this.readsThrow) throw new Error('sdk read failed');
    const room = this.rooms.get(roomId);
    return room ? { kind: 'done', value: room } : { kind: 'rejected', code: 'not_found' };
  }

  async sendEvent(input: Readonly<{ roomId: RoomId; clientTxnId: string; content: MessageContent }>): Promise<SubstrateEffect<AcceptedEvent>> {
    const attempt = this.sendCalls.filter(call => call.clientTxnId === input.clientTxnId).length;
    this.sendCalls.push({ clientTxnId: input.clientTxnId, body: input.content.body });
    const mode = this.sendMode(input.clientTxnId, attempt);
    if (mode === 'unavailable') return { kind: 'unavailable' };
    if (typeof mode === 'object') return { kind: 'rejected', code: mode.rejected };
    // Transaction dedupe: the same transaction on the same device lands once.
    let event = this.landed.find(item => item.clientTxnId === input.clientTxnId && item.deviceId === this.sendingDevice);
    if (!event) {
      event = { eventId: `$event-${this.landed.length + 1}` as EventId, roomId: input.roomId, clientTxnId: input.clientTxnId, content: input.content, deviceId: this.sendingDevice };
      this.landed.push(event);
    }
    if (mode === 'throw') throw new Error('network');
    return mode === 'lose' ? { kind: 'unknown' } : { kind: 'done', value: { eventId: event.eventId, authorDeviceId: event.deviceId } };
  }

  async timeline(): Promise<SubstrateRead<SubstratePage>> {
    if (this.readsThrow) throw new Error('sdk read failed');
    return this.page;
  }

  subscribe(roomId: RoomId, listener: (update: SubstrateUpdate) => void): () => void {
    const set = this.listeners.get(roomId) ?? new Set();
    set.add(listener);
    this.listeners.set(roomId, set);
    return () => set.delete(listener);
  }

  emit(roomId: RoomId, update: SubstrateUpdate): void {
    for (const listener of this.listeners.get(roomId) ?? []) listener(update);
  }

  subscribers(roomId: RoomId): number {
    return this.listeners.get(roomId)?.size ?? 0;
  }
}

export type Harness = Readonly<{
  service: RoomService;
  substrate: FakeSubstrate;
  device: ReturnType<typeof fakeDevice>;
  journal: RoomJournal;
  /** Epoch milliseconds the service reads; tests advance it. */
  time: { now: number };
  listenerErrors: unknown[];
}>;

export function harness(
  options: Partial<{ actor: ParticipantView; substrate: FakeSubstrate; journal: RoomJournal; principal: AuthPrincipal; newId: () => string }> = {},
): Harness {
  const substrate = options.substrate ?? new FakeSubstrate();
  const device = fakeDevice();
  const journal = options.journal ?? createMemoryRoomJournal();
  const time = { now: Date.parse('2026-09-17T00:00:00Z') };
  const listenerErrors: unknown[] = [];
  let id = 0;
  const service = createRoomService({
    principal: options.principal ?? principal, actor: options.actor ?? human, device, substrate, journal, limits,
    newId: options.newId ?? (() => `txn-${++id}`), clock: () => time.now, onListenerError: error => listenerErrors.push(error),
  });
  return { service, substrate, device, journal, time, listenerErrors };
}

/** Lets queued projection work settle. */
export const settle = () => new Promise(resolve => setTimeout(resolve, 0));
