import {
  ClientEvent,
  EventType,
  MatrixEvent,
  MsgType,
  Preset,
  Room,
  RoomEvent,
  SyncState,
  Visibility,
  createClient,
  type MatrixClient,
} from 'matrix-js-sdk';
import {
  decodeMessageContent,
  decodeRoomSummary,
  unavailable,
  type AuthPrincipal,
  type ContentLimits,
  type DeviceId,
  type DevicePort,
  type EventId,
  type IdentityPort,
  type MessageContent,
  type OwnerId,
  type ParticipantId,
  type ParticipantView,
  type RoomId,
  type RoomPort,
  type RoomRejection,
  type RoomSummary,
} from '@khala/contracts/messaging/index';
import {
  createBrowserDeviceService,
  createIndexedDbMarkerStore,
  createIndexedDbStoreFactory,
  createWebLockProvider,
  type CredentialSource,
  type DeviceEngineFactory,
  type EngineOpenInput,
} from '@khala/messaging/browser-device/index';
import {
  createRoomService,
  type RoomJournal,
  type CreateLookup,
  type RoomSubstrate,
  type SubstrateEffect,
  type SubstrateEvent,
  type SubstrateRead,
  type SubstrateUpdate,
} from '@khala/messaging/rooms/index';
import { createBrowserRoomJournal } from './room-journal';

const CREATE_EVENT = 'com.aiur.khala.create.v1';

type MatrixCredentials = Readonly<{ homeserverOrigin: string; userId: string; accessToken: string }>;
type ActiveClient = Readonly<{ client: MatrixClient; principal: AuthPrincipal; generation: number }>;

function credentials(value: unknown): MatrixCredentials | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.homeserverOrigin === 'string' && typeof candidate.userId === 'string'
    && typeof candidate.accessToken === 'string'
    ? candidate as MatrixCredentials
    : null;
}

function matrixFailure(error: unknown): RoomRejection | null {
  if (typeof error !== 'object' || error === null) return null;
  const value = error as { errcode?: unknown; httpStatus?: unknown };
  if (value.errcode === 'M_FORBIDDEN' || value.httpStatus === 403) return 'forbidden';
  if (value.errcode === 'M_NOT_FOUND' || value.httpStatus === 404) return 'not_found';
  return null;
}

function effectFailure<T>(error: unknown): SubstrateEffect<T> {
  const code = matrixFailure(error);
  return code ? { kind: 'rejected', code } : { kind: 'unknown' };
}

function readFailure<T>(error: unknown): SubstrateRead<T> {
  const code = matrixFailure(error);
  return code ? { kind: 'rejected', code } : { kind: 'unavailable' };
}

function roomSummary(room: Room, limits: ContentLimits): RoomSummary {
  const membership = room.getMyMembership();
  const base = {
    roomId: room.roomId as RoomId,
    title: room.name && room.name !== room.roomId ? room.name : null,
    membership: membership === 'join' ? 'joined' : membership === 'invite' || membership === 'knock' ? 'joining' : 'left',
    revision: room.getLastLiveEvent()?.getId() ?? `matrix:${room.roomId}`,
  };
  const decoded = decodeRoomSummary(base, limits);
  if (decoded.ok) return decoded.value;
  const withoutUntrustedTitle = decodeRoomSummary({ ...base, title: null }, limits);
  if (withoutUntrustedTitle.ok) return withoutUntrustedTitle.value;
  throw new Error('Matrix room metadata is invalid');
}

function startAndWaitForInitialSync(client: MatrixClient, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (done: () => void) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', abort);
      client.off(ClientEvent.Sync, synced);
      done();
    };
    const abort = () => finish(() => reject(new DOMException('aborted', 'AbortError')));
    const synced = (state: SyncState) => {
      if (state === SyncState.Prepared || state === SyncState.Syncing) finish(resolve);
      if (state === SyncState.Error || state === SyncState.Stopped) finish(() => reject(new Error('Matrix sync unavailable')));
    };
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    client.on(ClientEvent.Sync, synced);
    void Promise.resolve(client.startClient({ initialSyncLimit: 50, lazyLoadMembers: true, disablePresence: false }))
      .catch(error => finish(() => reject(error)));
  });
}

class MatrixRuntime {
  active: ActiveClient | null = null;

  constructor(private readonly device: () => DevicePort) {}

  engineFactory(): DeviceEngineFactory {
    const device = this.device;
    const principals = this.principalByOwner;
    const setActive = (active: ActiveClient | null) => { this.active = active; };
    const activeClient = () => this.active;
    return {
      open: async (input: EngineOpenInput) => {
        const session = credentials(input.session.credentials);
        if (session === null) throw new Error('Matrix credentials unavailable');
        const client = createClient({
          baseUrl: session.homeserverOrigin,
          userId: session.userId,
          accessToken: session.accessToken,
          deviceId: input.session.deviceId,
          localTimeoutMs: 30_000,
        });
        await client.initRustCrypto({ useIndexedDB: true, cryptoDatabasePrefix: input.store.name });
        const crypto = client.getCrypto();
        if (!crypto) throw new Error('Matrix crypto unavailable');
        let started = false;
        return {
          async identity() {
            const keys = await crypto.getOwnDeviceKeys();
            return { fingerprint: keys.ed25519, created: false };
          },
          async start(signal) {
            await startAndWaitForInitialSync(client, signal);
            started = true;
            const generation = device().current().generation;
            const principal = principals.get(input.ownerId);
            if (!principal) throw new Error('identity generation replaced');
            setActive({ client, principal, generation });
          },
          async close() {
            if (activeClient()?.client === client) setActive(null);
            if (started) client.stopClient();
          },
        };
      },
    };
  }

  readonly principalByOwner = new Map<OwnerId, AuthPrincipal>();
}

class MatrixSubstrate implements RoomSubstrate {
  constructor(private readonly runtime: MatrixRuntime, private readonly limits: ContentLimits) {}

  private active(): ActiveClient {
    if (this.runtime.active === null) throw new Error('Matrix client unavailable');
    return this.runtime.active;
  }

  async createRoom(input: Readonly<{ operationId: string; title: string | null }>): Promise<SubstrateEffect<RoomSummary>> {
    try {
      const { client } = this.active();
      const created = await client.createRoom({
        visibility: Visibility.Private,
        preset: Preset.PublicChat,
        ...(input.title ? { name: input.title } : {}),
        initial_state: [
          { type: EventType.RoomEncryption, state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
          { type: EventType.RoomHistoryVisibility, state_key: '', content: { history_visibility: 'joined' } },
          { type: CREATE_EVENT, state_key: '', content: { operation_id: input.operationId } },
        ],
      });
      return {
        kind: 'done',
        value: {
          roomId: created.room_id as RoomId,
          title: input.title,
          membership: 'joined',
          revision: `matrix:${created.room_id}`,
        },
      };
    } catch (error) {
      return effectFailure(error);
    }
  }

  async findCreatedRoom(input: Readonly<{ operationId: string }>): Promise<CreateLookup> {
    try {
      for (const room of this.active().client.getRooms()) {
        const marker = room.currentState.getStateEvents(CREATE_EVENT, '');
        if (marker?.getContent().operation_id === input.operationId) return { kind: 'found', room: roomSummary(room, this.limits) };
      }
      // A local sync not containing the marker is not proof that a timed-out
      // create did not land. Keep the operation indeterminate until a later
      // sync observes its marker instead of risking a duplicate room.
      return { kind: 'unknown' };
    } catch {
      return { kind: 'unavailable' };
    }
  }

  async room(roomId: RoomId): Promise<SubstrateRead<RoomSummary>> {
    const room = this.active().client.getRoom(roomId);
    return room ? { kind: 'done', value: roomSummary(room, this.limits) } : { kind: 'rejected', code: 'not_found' };
  }

  async sendEvent(input: Readonly<{ roomId: RoomId; clientTxnId: string; content: MessageContent }>): Promise<SubstrateEffect<{ eventId: EventId; authorDeviceId: DeviceId }>> {
    try {
      const { client } = this.active();
      const response = await client.sendEvent(input.roomId, EventType.RoomMessage, {
        msgtype: MsgType.Text,
        body: input.content.body,
      }, input.clientTxnId);
      return {
        kind: 'done',
        value: { eventId: response.event_id as EventId, authorDeviceId: client.getDeviceId() as DeviceId },
      };
    } catch (error) {
      return effectFailure(error);
    }
  }

  private event(room: Room, event: MatrixEvent): SubstrateEvent | null {
    const eventId = event.getId();
    const sender = event.getSender();
    if (!eventId || !sender) return null;
    const receivedAt = new Date(event.getTs()).toISOString();
    if (event.isDecryptionFailure()) {
      return {
        kind: 'undecryptable',
        eventId: eventId as EventId,
        authorParticipantId: sender as ParticipantId,
        reason: event.decryptionFailureReason === 'MEGOLM_UNKNOWN_INBOUND_SESSION_ID' ? 'missing_key' : 'decryption_failed',
        receivedAt,
      };
    }
    if (event.getType() !== EventType.RoomMessage) return null;
    const rawContent = event.getContent();
    const content = decodeMessageContent({ v: 1, kind: 'text', body: rawContent.body }, this.limits);
    if (!content.ok) return null;
    const active = this.active();
    const authorDeviceId = (event.getClaimedEd25519Key() ?? `matrix:${sender}`) as DeviceId;
    const participant: ParticipantView = {
      participantId: sender as ParticipantId,
      kind: 'human',
      ownerId: sender === active.client.getUserId() ? active.principal.ownerId : sender as OwnerId,
      displayName: sender,
      deviceIds: [authorDeviceId],
    };
    const transactionId = event.getUnsigned().transaction_id;
    return {
      kind: 'message',
      eventId: eventId as EventId,
      authorDeviceId,
      participant,
      content: content.value,
      clientTxnId: typeof transactionId === 'string' ? transactionId : null,
      receivedAt,
    };
  }

  private events(room: Room): readonly SubstrateEvent[] {
    return room.getLiveTimeline().getEvents().flatMap(event => {
      const projected = this.event(room, event);
      return projected ? [projected] : [];
    });
  }

  async timeline(input: Readonly<{ roomId: RoomId; cursor: string | null; limit: number }>): Promise<SubstrateRead<{ events: readonly SubstrateEvent[]; nextCursor: string | null; revision: string }>> {
    try {
      const room = this.active().client.getRoom(input.roomId);
      if (!room) return { kind: 'rejected', code: 'not_found' };
      if (input.cursor !== null) await this.active().client.scrollback(room, input.limit);
      const events = this.events(room);
      const offset = input.cursor === null ? 0 : Number.parseInt(input.cursor, 10);
      if (!Number.isSafeInteger(offset) || offset < 0) return { kind: 'rejected', code: 'invalid_request' };
      const end = Math.max(0, events.length - offset);
      const start = Math.max(0, end - input.limit);
      const page = events.slice(start, end);
      return {
        kind: 'done',
        value: {
          events: page,
          nextCursor: start > 0 ? String(offset + page.length) : null,
          revision: room.getLastLiveEvent()?.getId() ?? `matrix:${input.roomId}:empty`,
        },
      };
    } catch (error) {
      return readFailure(error);
    }
  }

  subscribe(roomId: RoomId, listener: (update: SubstrateUpdate) => void): () => void {
    let disposed = false;
    const active = this.runtime.active;
    const room = active?.client.getRoom(roomId);
    if (!active || !room) return () => undefined;
    const publish = () => {
      if (!disposed) listener({ generation: active.generation, room: roomSummary(room, this.limits), events: this.events(room) });
    };
    const receive = (_event: MatrixEvent, eventRoom: Room | undefined) => {
      if (eventRoom?.roomId === roomId) publish();
    };
    active.client.on(RoomEvent.Timeline, receive);
    publish();
    return () => {
      disposed = true;
      active.client.off(RoomEvent.Timeline, receive);
    };
  }
}

export type MatrixBrowserPorts = Readonly<{ device: DevicePort; room: RoomPort }>;

/** Binds the selected Matrix SDK to KHA-111/112 without exposing it to UI controllers. */
export function createMatrixBrowserPorts(input: Readonly<{
  identity: IdentityPort;
  credentials: CredentialSource;
  limits: ContentLimits;
}>): MatrixBrowserPorts {
  const runtime = new MatrixRuntime(() => device);
  const credentialSource: CredentialSource = {
    async resolve(principal, signal) {
      runtime.principalByOwner.set(principal.ownerId, principal);
      return input.credentials.resolve(principal, signal);
    },
  };
  const device = createBrowserDeviceService({
    identity: input.identity,
    credentials: credentialSource,
    stores: createIndexedDbStoreFactory(),
    markers: createIndexedDbMarkerStore(),
    locks: createWebLockProvider(),
    engines: runtime.engineFactory(),
  });
  const substrate = new MatrixSubstrate(runtime, input.limits);
  const journals = new Map<OwnerId, RoomJournal>();
  let current: { ownerId: OwnerId; generation: number; service: ReturnType<typeof createRoomService> } | null = null;

  function service(): ReturnType<typeof createRoomService> | null {
    const active = runtime.active;
    const view = device.current();
    if (!active || view.state !== 'ready' || view.deviceId === null || active.generation !== view.generation) return null;
    if (current?.ownerId === active.principal.ownerId && current.generation === view.generation) return current.service;
    current?.service.stop();
    const actor: ParticipantView = {
      participantId: active.client.getUserId() as ParticipantId,
      kind: 'human',
      ownerId: active.principal.ownerId,
      displayName: active.principal.verifiedEmail,
      deviceIds: [view.deviceId],
    };
    const next = createRoomService({
      principal: active.principal,
      actor,
      device,
      substrate,
      journal: journals.get(active.principal.ownerId) ?? (() => {
        const journal = createBrowserRoomJournal(active.principal.ownerId);
        journals.set(active.principal.ownerId, journal);
        return journal;
      })(),
      limits: input.limits,
    });
    current = { ownerId: active.principal.ownerId, generation: view.generation, service: next };
    return next;
  }

  const room: RoomPort = {
    create: (value, options) => service()?.create(value, options) ?? Promise.resolve(unavailable()),
    prepareIntro: (value, options) => service()?.prepareIntro(value, options) ?? Promise.resolve(unavailable()),
    resumeIntro: (value, options) => service()?.resumeIntro(value, options) ?? Promise.resolve(unavailable()),
    send: (value, options) => service()?.send(value, options) ?? Promise.resolve(unavailable()),
    timeline: (value, options) => service()?.timeline(value, options) ?? Promise.resolve(unavailable()),
    observe(roomId, listener) {
      return service()?.observe(roomId, listener) ?? (() => undefined);
    },
  };

  return { device, room };
}
