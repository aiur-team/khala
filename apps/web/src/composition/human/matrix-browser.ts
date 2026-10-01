import {
  ClientEvent,
  Direction,
  EventType,
  MatrixEvent,
  MatrixEventEvent,
  MsgType,
  Preset,
  Room,
  RoomEvent,
  RoomMemberEvent,
  SyncState,
  Visibility,
  createClient,
  type MatrixClient,
  type EventTimeline,
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
  type ParticipantView,
  type RoomId,
  type RoomPort,
  type RoomRejection,
  type RoomSummary,
} from '@khala/contracts/messaging/index';
import type { NameTimelineEvent } from '@khala/contracts/messaging/agent-names';
import { publishAgentNameSnapshots } from './name-snapshots';
import { attachNameTargets } from './name-targets';
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
  type ChannelService,
  type RoomJournal,
  type CreateLookup,
  type RoomSubstrate,
  type SubstrateEffect,
  type SubstrateEvent,
  type SubstrateRead,
  type SubstrateUpdate,
} from '@khala/messaging/rooms/index';
import { createBrowserRoomJournal } from './room-journal';
import type { BrowserSendFence, BrowserSendProof } from './browser-api';
import { sortConversations, type ConversationIndexPort } from './conversations';
import type { ConversationSummary } from '../../ui/conversation';

const CREATE_EVENT = 'com.aiur.khala.create.v1';

function historyDiagnostic(stage: 'history_participants' | 'history_device_info'): void {
  if (typeof window === 'undefined' ||
      (window as Window & { __khalaLocalHistoryDiagnostics?: boolean }).__khalaLocalHistoryDiagnostics !== true) return;
  window.dispatchEvent(new CustomEvent('khala:local-history-diagnostic', { detail: stage }));
}

type MatrixCredentials = Readonly<{ homeserverOrigin: string; userId: string; accessToken: string }>;
type ActiveClient = Readonly<{
  client: MatrixClient;
  principal: AuthPrincipal;
  actor: ParticipantView;
  generation: number;
}>;
type ParticipantResolver = Readonly<{
  resolve(userIds: readonly string[], signal?: AbortSignal, roomId?: RoomId, targetParticipantIds?: readonly ParticipantView['participantId'][]): Promise<ReadonlyMap<string, ParticipantView> | null>;
}>;

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

/** Only local, joined encrypted rooms enter the owner conversation index. */
export function projectJoinedEncryptedRooms(client: Pick<MatrixClient, 'getRooms'>, limits: ContentLimits): readonly ConversationSummary[] {
  return sortConversations(client.getRooms()
    .filter(candidate => candidate.getMyMembership() === 'join' && candidate.hasEncryptionStateEvent())
    .map(candidate => {
      const summary = roomSummary(candidate, limits);
      const latest = [...candidate.getLiveTimeline().getEvents()].reverse().find(event =>
        (event.getType() === EventType.RoomMessage && event.getContent().msgtype === MsgType.Text)
        || event.getType() === 'm.room.encrypted' || event.isDecryptionFailure());
      const body = latest?.getType() === EventType.RoomMessage && !latest.isDecryptionFailure()
        ? latest.getClearContent()?.body : null;
      const unread = candidate.getUnreadNotificationCount();
      return {
        id: summary.roomId,
        title: summary.title ?? 'Encrypted conversation',
        preview: typeof body === 'string' ? body : null,
        timestamp: latest ? new Date(latest.getTs()).toISOString() : null,
        unreadCount: Number.isSafeInteger(unread) && unread > 0 ? unread : null,
      };
    }));
}

/** Rebinds decrypt listeners as sync adds or removes events; all callbacks share the session fence. */
export function subscribeConversationIndex(client: Pick<MatrixClient, 'getRooms' | 'on' | 'off'>,
  isCurrent: () => boolean, listener: () => void): () => void {
  const observed = new Set<MatrixEvent>();
  let disposed = false;
  const onDecrypted = () => { if (!disposed && isCurrent()) listener(); };
  const bindEvents = () => {
    const available = new Set(client.getRooms()
      .filter(room => room.getMyMembership() === 'join' && room.hasEncryptionStateEvent())
      .flatMap(room => room.getLiveTimeline().getEvents()));
    for (const event of observed) {
      if (!available.has(event)) { event.off(MatrixEventEvent.Decrypted, onDecrypted); observed.delete(event); }
    }
    for (const event of available) {
      if (!observed.has(event)) { event.on(MatrixEventEvent.Decrypted, onDecrypted); observed.add(event); }
    }
  };
  const publish = () => {
    if (disposed || !isCurrent()) return;
    try { bindEvents(); } catch { /* Snapshot reports unavailable without crashing the route. */ }
    listener();
  };
  client.on(RoomEvent.Timeline, publish);
  client.on(ClientEvent.Sync, publish);
  publish();
  return () => {
    disposed = true;
    client.off(RoomEvent.Timeline, publish);
    client.off(ClientEvent.Sync, publish);
    for (const event of observed) event.off(MatrixEventEvent.Decrypted, onDecrypted);
    observed.clear();
  };
}

/** A late Megolm key changes an existing event without adding a timeline row. */
export function subscribeRoomDecryption(client: Pick<MatrixClient, 'on' | 'off'>,
  roomId: RoomId, isCurrent: () => boolean, publish: () => void): () => void {
  const onDecrypted = (event: MatrixEvent) => {
    if (isCurrent() && event.getRoomId() === roomId) publish();
  };
  client.on(MatrixEventEvent.Decrypted, onDecrypted);
  return () => client.off(MatrixEventEvent.Decrypted, onDecrypted);
}

/** Initial sync does not decrypt every timeline event; attempt each one before projection. */
export async function decryptTimelineEvents(client: Pick<MatrixClient, 'decryptEventIfNeeded'>,
  events: readonly MatrixEvent[]): Promise<void> {
  await Promise.all(events.map(async event => {
    if (event.getType() !== 'm.room.encrypted' || event.isDecryptionFailure()) return;
    // Missing historical keys are represented as unavailable entries. The SDK
    // retries them when keys arrive and emits MatrixEventEvent.Decrypted.
    try { await client.decryptEventIfNeeded(event); } catch { /* Keep the ciphertext entry. */ }
  }));
}

/** A live event can arrive while history is loading; only backward insertions belong to the page. */
export async function paginateHistoricalEvents(client: Pick<MatrixClient, 'on' | 'off' | 'paginateEventTimeline'>,
  timeline: EventTimeline, roomId: RoomId, limit: number): Promise<Readonly<{ events: readonly MatrixEvent[]; hasMore: boolean }>> {
  const historicalIds = new Set<string>();
  const record = (event: MatrixEvent, room: Room | undefined, toStartOfTimeline: boolean | undefined) => {
    const id = event.getId();
    if (room?.roomId === roomId && toStartOfTimeline && id) historicalIds.add(id);
  };
  client.on(RoomEvent.Timeline, record);
  try {
    const hasMore = await client.paginateEventTimeline(timeline, { backwards: true, limit });
    return { events: timeline.getEvents().filter(event => historicalIds.has(event.getId() ?? '')), hasMore };
  } finally {
    client.off(RoomEvent.Timeline, record);
  }
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

export async function startMatrixClient(client: MatrixClient, signal: AbortSignal): Promise<void> {
  try {
    await startAndWaitForInitialSync(client, signal);
  } catch (error) {
    client.stopClient();
    throw error;
  }
}

export function createMatrixRoomRequest(input: Readonly<{ operationId: string; title: string | null }>) {
  return {
    visibility: Visibility.Private,
    preset: Preset.PrivateChat,
    ...(input.title ? { name: input.title } : {}),
    initial_state: [
      { type: EventType.RoomEncryption, state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
      { type: EventType.RoomHistoryVisibility, state_key: '', content: { history_visibility: 'joined' } },
      { type: CREATE_EVENT, state_key: '', content: { operation_id: input.operationId } },
    ],
  };
}

async function waitForEncryptedRoom(client: MatrixClient, roomId: string, signal?: AbortSignal): Promise<Room> {
  const combined = AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]);
  while (!combined.aborted) {
    const room = client.getRoom(roomId);
    if (room?.hasEncryptionStateEvent()) return room;
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(combined.reason);
      };
      const timer = setTimeout(() => {
        combined.removeEventListener('abort', abort);
        resolve();
      }, 25);
      combined.addEventListener('abort', abort, { once: true });
    });
  }
  throw combined.reason;
}

class MatrixRuntime {
  active: ActiveClient | null = null;

  constructor(private readonly device: () => DevicePort, private readonly participants: ParticipantResolver) {}

  engineFactory(): DeviceEngineFactory {
    const device = this.device;
    const principals = this.principalByOwner;
    const participants = this.participants;
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
        let startInvoked = false;
        let stopped = false;
        return {
          async identity() {
            const keys = await crypto.getOwnDeviceKeys();
            return { fingerprint: keys.ed25519, created: false };
          },
          async start(signal) {
            startInvoked = true;
            try {
              await startMatrixClient(client, signal);
            } catch (error) {
              stopped = true;
              throw error;
            }
            try {
              const generation = device().current().generation;
              const principal = principals.get(input.ownerId);
              if (!principal) throw new Error('identity generation replaced');
              const userId = client.getUserId();
              if (!userId) throw new Error('Matrix user identity unavailable');
              const mappings = await participants.resolve([userId], signal);
              const mapping = mappings?.get(userId);
              if (!mapping) throw new Error('Matrix participant mapping unavailable');
              setActive({
                client,
                principal,
                actor: { ...mapping, displayName: principal.verifiedEmail, deviceIds: [input.session.deviceId] },
                generation,
              });
            } catch (error) {
              stopped = true;
              client.stopClient();
              throw error;
            }
          },
          async close() {
            if (activeClient()?.client === client) setActive(null);
            if (startInvoked && !stopped) {
              stopped = true;
              client.stopClient();
            }
          },
        };
      },
    };
  }

  readonly principalByOwner = new Map<OwnerId, AuthPrincipal>();
}

/** Project a Matrix event without mistaking pending ciphertext for an empty room. */
export function projectMatrixTimelineEvent(event: MatrixEvent, participant: ParticipantView,
  authorDeviceId: DeviceId | null, limits: ContentLimits): SubstrateEvent | null {
  const eventId = event.getId();
  const sender = event.getSender();
  if (!eventId || !sender) return null;
  const receivedAt = new Date(event.getTs()).toISOString();
  if (event.isDecryptionFailure()) {
    return {
      kind: 'undecryptable', eventId: eventId as EventId,
      authorParticipantId: participant.participantId,
      reason: event.decryptionFailureReason === 'MEGOLM_UNKNOWN_INBOUND_SESSION_ID' ? 'missing_key' : 'decryption_failed',
      receivedAt,
    };
  }
  if (event.getType() === 'm.room.encrypted') {
    return { kind: 'undecryptable', eventId: eventId as EventId,
      authorParticipantId: participant.participantId, reason: 'decryption_failed', receivedAt };
  }
  if (event.getType() !== EventType.RoomMessage) return null;
  const rawContent = event.getContent();
  if (rawContent.msgtype !== MsgType.Text && rawContent.msgtype !== MsgType.Notice) return null;
  if (rawContent.msgtype === MsgType.Notice && typeof rawContent['com.khala.agent_participant_id'] !== 'string') return null;
  const content = decodeMessageContent(rawContent.msgtype === MsgType.Notice
    ? { v: 1, kind: rawContent['com.khala.name_snapshot'] === true ? 'agent_name_snapshot' : 'agent_rename', body: rawContent.body,
        agentParticipantId: rawContent['com.khala.agent_participant_id'],
        ...(rawContent['com.khala.name_snapshot'] === true ? { sourceEventId: rawContent['com.khala.name_source_event_id'] } : {}) }
    : { v: 1, kind: 'text', body: rawContent.body }, limits);
  if (!content.ok || authorDeviceId === null) return null;
  const transactionId = event.getUnsigned().transaction_id;
  return {
    kind: 'message', eventId: eventId as EventId, authorDeviceId, participant,
    content: content.value, clientTxnId: typeof transactionId === 'string' ? transactionId : null,
    receivedAt,
  };
}

class MatrixSubstrate implements RoomSubstrate {
  private readonly readyRooms = new Set<string>();
  private readonly rotationReceipts = new Set<string>();
  private pollCursor = 0;
  private polling = false;
  constructor(
    private readonly runtime: MatrixRuntime,
    private readonly limits: ContentLimits,
    private readonly participants: ParticipantResolver,
    private readonly sendFence: BrowserSendFence | undefined,
  ) {
    if (sendFence) globalThis.setInterval(() => { void this.pollRotations(); }, 5_000);
  }

  private async pollRotations(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try { await this.pollRotationsOnce(); } finally { this.polling = false; }
  }

  private async pollRotationsOnce(): Promise<void> {
    const active = this.runtime.active;
    if (!active || !this.sendFence) return;
    const client = active.client;
    const crypto = client.getCrypto();
    const deviceId = client.getDeviceId();
    const matrixAccessToken = client.getAccessToken();
    if (!crypto || !deviceId || !matrixAccessToken) return;
    const rooms = client.getRooms().filter(room => room.getMyMembership() === 'join' && room.hasEncryptionStateEvent());
    if (rooms.length === 0) return;
    const count = Math.min(rooms.length, 4);
    for (let offset = 0; offset < count; offset++) {
      if (this.runtime.active?.client !== client) break;
      const room = rooms[(this.pollCursor + offset) % rooms.length]!;
      const proof: BrowserSendProof = { roomId: room.roomId as RoomId, deviceId, matrixAccessToken };
      const hold = await this.sendFence.inspect(proof);
      if (this.runtime.active?.client !== client) break;
      if (!hold) continue;
      const receipt = `${room.roomId}:${hold.operationId}:${hold.epoch}:${deviceId}`;
      if (this.rotationReceipts.has(receipt)) continue;
      try {
        await crypto.forceDiscardSession(room.roomId);
        if (this.runtime.active?.client !== client) break;
        if (await this.sendFence.rotation(proof, hold.operationId, hold.epoch)) this.rotationReceipts.add(receipt);
      } catch { /* An offline SDK remains pending until the next poll. */ }
    }
    this.pollCursor = (this.pollCursor + count) % rooms.length;
  }

  private active(): ActiveClient {
    if (this.runtime.active === null) throw new Error('Matrix client unavailable');
    return this.runtime.active;
  }

  async createRoom(input: Readonly<{ operationId: string; title: string | null }>, options?: { signal?: AbortSignal }): Promise<SubstrateEffect<RoomSummary>> {
    try {
      const { client } = this.active();
      const created = await client.createRoom(createMatrixRoomRequest(input));
      await waitForEncryptedRoom(client, created.room_id, options?.signal);
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
      const active = this.active();
      const { client } = active;
      const room = client.getRoom(input.roomId);
      if (!room?.hasEncryptionStateEvent()) return { kind: 'unavailable' };
      if (!this.sendFence) return { kind: 'unavailable' };
      const crypto = client.getCrypto();
      const deviceId = client.getDeviceId();
      const matrixAccessToken = client.getAccessToken();
      if (!crypto || !deviceId || !matrixAccessToken) return { kind: 'unavailable' };
      const proof: BrowserSendProof = { roomId: input.roomId, deviceId, matrixAccessToken };
      const readyKey = `${client.getUserId()}:${deviceId}:${active.generation}:${input.roomId}`;
      if (!this.readyRooms.has(readyKey)) {
        await crypto.forceDiscardSession(input.roomId);
        if (await this.sendFence.ready(proof)) this.readyRooms.add(readyKey);
      }
      const acquired = await this.sendFence.acquire(proof, input.clientTxnId);
      if (acquired?.kind === 'complete') {
        return { kind: 'done', value: { eventId: acquired.eventId as EventId, authorDeviceId: deviceId as DeviceId } };
      }
      if (acquired?.kind === 'held') {
        if (acquired.operationId !== 'rotation_required') {
          await crypto.forceDiscardSession(input.roomId);
          await this.sendFence.rotation(proof, acquired.operationId, acquired.epoch);
        }
        return { kind: 'unavailable' };
      }
      if (acquired?.kind !== 'granted') return { kind: 'unavailable' };
      this.readyRooms.add(readyKey);
      if (this.runtime.active?.client !== client || !client.getRoom(input.roomId)?.hasEncryptionStateEvent()) {
        await this.sendFence.finish(proof, acquired.permitId, { kind: 'cancelled' });
        return { kind: 'unavailable' };
      }
      let response: Awaited<ReturnType<typeof client.sendEvent>>;
      try {
        const payload = input.content.kind === 'agent_rename' || input.content.kind === 'agent_name_snapshot'
            ? { msgtype: MsgType.Notice, body: input.content.body,
                'com.khala.agent_participant_id': input.content.agentParticipantId,
                ...(input.content.kind === 'agent_name_snapshot' ? { 'com.khala.name_snapshot': true, 'com.khala.name_source_event_id': input.content.sourceEventId } : {}) }
            : { msgtype: MsgType.Text, body: input.content.body };
        response = await client.sendEvent(input.roomId, EventType.RoomMessage,
          payload as { msgtype: MsgType.Text | MsgType.Notice; body: string }, input.clientTxnId);
      } catch (error) {
        await this.sendFence.finish(proof, acquired.permitId, { kind: 'unknown' });
        return effectFailure(error);
      }
      if (!await this.sendFence.finish(proof, acquired.permitId, { kind: 'complete', eventId: response.event_id })) {
        return { kind: 'unknown' };
      }
      return {
        kind: 'done',
        value: { eventId: response.event_id as EventId, authorDeviceId: client.getDeviceId() as DeviceId },
      };
    } catch (error) {
      return effectFailure(error);
    }
  }

  private async events(events: readonly MatrixEvent[], roomId: RoomId): Promise<readonly SubstrateEvent[]> {
    const active = this.active();
    await decryptTimelineEvents(active.client, events);
    if (this.runtime.active !== active) throw new Error('Matrix session changed during timeline decryption');
    const senders = [...new Set(events.flatMap(event => event.getSender() ? [event.getSender()!] : []))];
    const mappings = await this.participants.resolve(senders, undefined, roomId).catch(error => {
      historyDiagnostic('history_participants');
      throw error;
    });
    if (this.runtime.active !== active) {
      historyDiagnostic('history_participants');
      throw new Error('Matrix session changed during participant resolution');
    }
    const crypto = active.client.getCrypto();
    if (mappings === null) {
      historyDiagnostic('history_participants');
      throw new Error('Matrix participant attribution unavailable');
    }
    if (crypto === undefined) {
      historyDiagnostic('history_device_info');
      throw new Error('Matrix crypto unavailable');
    }
    const devices = await crypto.getUserDeviceInfo(senders, true).catch(error => {
      historyDiagnostic('history_device_info');
      throw error;
    });
    if (this.runtime.active !== active) {
      historyDiagnostic('history_device_info');
      throw new Error('Matrix session changed during device attribution');
    }
    const projectedEvents = events.flatMap(event => {
      const sender = event.getSender();
      const mapping = sender ? mappings.get(sender) : undefined;
      if (!sender || !mapping) return [];
      const claimed = event.getClaimedEd25519Key();
      const device = claimed
        ? [...(devices.get(sender)?.values() ?? [])].find(candidate => candidate.getFingerprint() === claimed)
        : undefined;
      const deviceId = device?.deviceId as DeviceId | undefined;
      if (!event.isDecryptionFailure() && event.getType() === EventType.RoomMessage && deviceId === undefined) {
        historyDiagnostic('history_device_info');
        throw new Error('Matrix author device attribution unavailable');
      }
      const participant: ParticipantView = {
        ...mapping,
        displayName: sender === active.client.getUserId() ? active.principal.verifiedEmail : mapping.displayName,
        deviceIds: deviceId ? [deviceId] : [],
      };
      const projected = projectMatrixTimelineEvent(event, participant, deviceId ?? null, this.limits);
      return projected ? [projected] : [];
    });
    return attachNameTargets(projectedEvents,
      targetId => this.participants.resolve([], undefined, roomId, [targetId]),
      () => this.runtime.active === active).catch(error => {
      historyDiagnostic('history_participants');
      throw error;
    });
  }

  async timeline(input: Readonly<{ roomId: RoomId; cursor: string | null; limit: number }>): Promise<SubstrateRead<{ events: readonly SubstrateEvent[]; nextCursor: string | null; revision: string }>> {
    try {
      const active = this.active();
      const room = active.client.getRoom(input.roomId);
      if (!room) return { kind: 'rejected', code: 'not_found' };
      const timeline = room.getLiveTimeline();
      const currentCursor = timeline.getPaginationToken(Direction.Backward);
      let source: readonly MatrixEvent[];
      let hasMore = currentCursor !== null;
      if (input.cursor === null) {
        const all = timeline.getEvents();
        source = all.slice(Math.max(0, all.length - input.limit));
      } else {
        if (input.cursor !== currentCursor) return { kind: 'rejected', code: 'invalid_request' };
        const page = await paginateHistoricalEvents(active.client, timeline, input.roomId, input.limit);
        hasMore = page.hasMore;
        source = page.events;
      }
      if (this.runtime.active !== active) throw new Error('Matrix session changed during timeline pagination');
      const page = await this.events(source, input.roomId);
      if (this.runtime.active !== active) throw new Error('Matrix session changed during timeline projection');
      return {
        kind: 'done',
        value: {
          events: page,
          nextCursor: hasMore ? timeline.getPaginationToken(Direction.Backward) : null,
          revision: room.getLastLiveEvent()?.getId() ?? `matrix:${input.roomId}:empty`,
        },
      };
    } catch (error) {
      return readFailure(error);
    }
  }

  private async publishNameSnapshots(roomId: RoomId, membershipEventId: string): Promise<void> {
    const active = this.active();
    const room = active.client.getRoom(roomId);
    if (!room || room.getMyMembership() !== 'join' || !room.hasEncryptionStateEvent()) return;
    const timeline = room.getLiveTimeline();
    // Only this owner's existing history keys are used. New members receive fresh
    // encrypted metadata; no historical keys or old chat bodies are redistributed.
    while (timeline.getPaginationToken(Direction.Backward) !== null) {
      const before = timeline.getPaginationToken(Direction.Backward);
      if (!await active.client.paginateEventTimeline(timeline, { backwards: true, limit: 100 })) break;
      if (before === timeline.getPaginationToken(Direction.Backward)) throw new Error('name_history_stalled');
    }
    await Promise.all(timeline.getEvents().filter(event => event.isEncrypted()).map(event => active.client.decryptEventIfNeeded(event)));
    const events = await this.events(timeline.getEvents(), roomId);
    if (events.some(event => event.kind === 'undecryptable')) throw new Error('name_history_unavailable');
    const roster = await this.participants.resolve(room.getJoinedMembers().map(member => member.userId), undefined, roomId);
    if (!roster) throw new Error('name_roster_unavailable');
    if (this.runtime.active !== active) return;
    await publishAgentNameSnapshots({ roomId, membershipEventId, ownerId: active.principal.ownerId,
      isCurrent: () => this.runtime.active === active, send: value => this.sendEvent(value),
      participants: [...roster.values()].map(participant => ({
        participantId: participant.participantId, ownerId: participant.ownerId,
        kind: participant.kind, initialName: participant.displayName,
      })), events: events.flatMap((event): NameTimelineEvent[] => event.kind === 'message'
      ? [event.content.kind === 'text'
        ? { kind: 'message' as const, eventId: event.eventId, authorParticipantId: event.participant.participantId }
        : { kind: event.content.kind, eventId: event.eventId, actorParticipantId: event.participant.participantId,
            targetParticipantId: event.content.agentParticipantId, name: event.content.body,
            sourceEventId: event.content.kind === 'agent_name_snapshot' ? event.content.sourceEventId : null }]
      : []) });
  }

  subscribe(roomId: RoomId, listener: (update: SubstrateUpdate) => void): () => void {
    let disposed = false;
    const active = this.runtime.active;
    const room = active?.client.getRoom(roomId);
    if (!active || !room) return () => undefined;
    let publishEpoch = 0;
    const publish = () => {
      if (disposed || this.runtime.active !== active) return;
      const epoch = ++publishEpoch;
      void this.events(room.getLiveTimeline().getEvents(), roomId).then(events => {
        if (!disposed && this.runtime.active === active && epoch === publishEpoch) {
          listener({ generation: active.generation, room: roomSummary(room, this.limits), events });
        }
      }).catch(() => undefined);
    };
    const receive = (_event: MatrixEvent, eventRoom: Room | undefined) => {
      if (eventRoom?.roomId === roomId) publish();
    };
    let snapshotRetry: ReturnType<typeof setTimeout> | null = null;
    let snapshotInFlight = false;
    let membershipEpoch: string | null = null;
    let publishedEpoch: string | null = null;
    const bootstrap = () => {
      if (disposed || this.runtime.active !== active || !membershipEpoch || publishedEpoch === membershipEpoch || snapshotInFlight) return;
      snapshotInFlight = true;
      const epoch = membershipEpoch;
      void this.publishNameSnapshots(roomId, epoch).then(() => { publishedEpoch = epoch; }).catch(() => {
        if (!disposed && snapshotRetry === null) snapshotRetry = setTimeout(() => {
          snapshotRetry = null;
          bootstrap();
        }, 5_000);
      }).finally(() => {
        snapshotInFlight = false;
        if (membershipEpoch !== epoch) bootstrap();
      });
    };
    const membership = (event: MatrixEvent) => {
      if (event.getRoomId() !== roomId || event.getContent().membership !== 'join' || !event.getId()) return;
      membershipEpoch = event.getId()!;
      bootstrap();
    };
    active.client.on(RoomMemberEvent.Membership, membership);
    active.client.on(RoomEvent.Timeline, receive);
    // Recovery after an offline owner/reload: bootstrap the current membership epoch.
    const joined = room.getJoinedMembers().map(member => member.events.member?.getId()).filter((id): id is string => !!id).sort();
    membershipEpoch = JSON.stringify(joined);
    bootstrap();
    const disposeDecryption = subscribeRoomDecryption(active.client, roomId,
      () => !disposed && this.runtime.active === active, publish);
    publish();
    return () => {
      disposed = true;
      if (snapshotRetry !== null) clearTimeout(snapshotRetry);
      active.client.off(RoomEvent.Timeline, receive);
      active.client.off(RoomMemberEvent.Membership, membership);
      disposeDecryption();
    };
  }
}

export type MatrixBrowserPorts = Readonly<{
  device: DevicePort;
  room: RoomPort & Pick<ChannelService, 'observeEntries'>;
  conversations: ConversationIndexPort;
  participant(): ParticipantView | null;
  roomParticipants(roomId: RoomId, signal?: AbortSignal): Promise<readonly ParticipantView[] | null>;
  /** Requests SDK cleanup of this owner's local room state after protected closure. */
  cleanupRoom(ownerId: OwnerId, roomId: RoomId): Promise<boolean>;
  /** Detect a sync race that restored a room after local cleanup resolved. */
  roomPresent(ownerId: OwnerId, roomId: RoomId): boolean;
  /** Trusted owner endpoint discards its outbound Megolm session before a new device can receive sends. */
  discardOutboundSession(roomId: RoomId): Promise<boolean>;
  /** Trusts one server-attested agent Matrix device only after exact SDK fingerprint comparison. */
  trustAgentDevice(roomId: RoomId, userId: string, deviceId: string, fingerprint: string): Promise<boolean>;
  /** Transient proof material for the protected owner-device registration request. */
  ownerDeviceProof(): Promise<Readonly<{ deviceId: string; fingerprint: string; matrixAccessToken: string }> | null>;
}>;

/** Binds the selected Matrix SDK to KHA-111/112 without exposing it to UI controllers. */
export function createMatrixBrowserPorts(input: Readonly<{
  identity: IdentityPort;
  credentials: CredentialSource;
  limits: ContentLimits;
  participants: ParticipantResolver;
  sendFence?: BrowserSendFence;
}>): MatrixBrowserPorts {
  const runtime = new MatrixRuntime(() => device, input.participants);
  const credentialSource: CredentialSource = {
    async resolve(principal, signal) {
      runtime.principalByOwner.set(principal.ownerId, principal);
      return input.credentials.resolve(principal, signal);
    },
  };
  const browserDevice = createBrowserDeviceService({
    identity: input.identity,
    credentials: credentialSource,
    stores: createIndexedDbStoreFactory(),
    markers: createIndexedDbMarkerStore(),
    locks: createWebLockProvider(),
    engines: runtime.engineFactory(),
  });
  const substrate = new MatrixSubstrate(runtime, input.limits, input.participants, input.sendFence);
  const journals = new Map<OwnerId, RoomJournal>();
  let current: { ownerId: OwnerId; generation: number; service: ReturnType<typeof createRoomService> } | null = null;
  const device: DevicePort = {
    ...browserDevice,
    async stop() {
      await browserDevice.stop();
      current?.service.stop();
      current = null;
      journals.clear();
      runtime.principalByOwner.clear();
    },
  };

  function service(): ReturnType<typeof createRoomService> | null {
    const active = runtime.active;
    const view = device.current();
    if (!active || view.state !== 'ready' || view.deviceId === null || active.generation !== view.generation) return null;
    if (current?.ownerId === active.principal.ownerId && current.generation === view.generation) return current.service;
    current?.service.stop();
    const next = createRoomService({
      principal: active.principal,
      actor: active.actor,
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

  const room: RoomPort & Pick<ChannelService, 'observeEntries'> = {
    create: (value, options) => service()?.create(value, options) ?? Promise.resolve(unavailable()),
    prepareIntro: (value, options) => service()?.prepareIntro(value, options) ?? Promise.resolve(unavailable()),
    resumeIntro: (value, options) => service()?.resumeIntro(value, options) ?? Promise.resolve(unavailable()),
    send: (value, options) => service()?.send(value, options) ?? Promise.resolve(unavailable()),
    timeline: (value, options) => service()?.timeline(value, options) ?? Promise.resolve(unavailable()),
    observe(roomId, listener) {
      return service()?.observe(roomId, listener) ?? (() => undefined);
    },
    observeEntries(roomId, listener) {
      return service()?.observeEntries(roomId, listener) ?? (() => undefined);
    },
  };

  const conversations: ConversationIndexPort = {
    snapshot(ownerId, generation) {
      const active = runtime.active;
      const view = device.current();
      if (!active || active.principal.ownerId !== ownerId || view.state !== 'ready' || view.generation !== generation || active.generation !== generation) return null;
      try { return projectJoinedEncryptedRooms(active.client, input.limits); } catch { return null; }
    },
    subscribe(ownerId, generation, listener) {
      const active = runtime.active;
      if (!active || active.principal.ownerId !== ownerId || active.generation !== generation) return () => undefined;
      return subscribeConversationIndex(active.client,
        () => runtime.active === active && device.current().generation === generation, listener);
    },
  };

  return {
    device, room, conversations, participant: () => runtime.active?.actor ?? null,
    async roomParticipants(roomId, signal) {
      const active = runtime.active;
      if (!active || !active.client.getRoom(roomId)?.hasEncryptionStateEvent()) return null;
      try {
        const joined = await active.client.getJoinedRoomMembers(roomId);
        if (signal?.aborted || runtime.active !== active) return null;
        const userIds = Object.keys(joined.joined);
        const mapping = await input.participants.resolve(userIds, signal, roomId);
        if (!mapping || !userIds.every(userId => mapping.has(userId)) || signal?.aborted || runtime.active !== active) return null;
        return userIds.map(userId => mapping.get(userId)!).filter(Boolean);
      } catch { return null; }
    },
    roomPresent(ownerId, roomId) {
      const active = runtime.active;
      return active?.principal.ownerId === ownerId && active.client.getRoom(roomId) !== null;
    },
    async cleanupRoom(ownerId, roomId) {
      const active = runtime.active;
      if (active?.principal.ownerId !== ownerId) return false;
      try {
        await active.client.forget(roomId, true);
        return true;
      } catch {
        return false;
      }
    },
    async discardOutboundSession(roomId) {
      const active = runtime.active;
      if (!active?.client.getRoom(roomId)?.hasEncryptionStateEvent()) return false;
      const crypto = active.client.getCrypto();
      if (!crypto) return false;
      try {
        await crypto.forceDiscardSession(roomId);
        return true;
      } catch {
        return false;
      }
    },
    async trustAgentDevice(roomId, userId, deviceId, fingerprint) {
      const active = runtime.active;
      if (!active?.client.getRoom(roomId)?.hasEncryptionStateEvent()
        || !userId.startsWith('@') || !deviceId || !/^[A-Za-z0-9+/]{43}=?$/u.test(fingerprint)) return false;
      const crypto = active.client.getCrypto();
      if (!crypto) return false;
      try {
        const device = (await crypto.getUserDeviceInfo([userId], true)).get(userId)?.get(deviceId);
        if (!device || device.getFingerprint() !== fingerprint) return false;
        await crypto.setDeviceVerified(userId, deviceId, true);
        if (!(await crypto.getDeviceVerificationStatus(userId, deviceId))?.isVerified()) return false;
        await crypto.forceDiscardSession(roomId);
        return true;
      } catch {
        return false;
      }
    },
    async ownerDeviceProof() {
      const active = runtime.active;
      const view = device.current();
      if (!active || view.state !== 'ready' || active.generation !== view.generation) return null;
      const crypto = active.client.getCrypto();
      const deviceId = active.client.getDeviceId();
      const matrixAccessToken = active.client.getAccessToken();
      if (!crypto || !deviceId || !matrixAccessToken) return null;
      try {
        const fingerprint = (await crypto.getOwnDeviceKeys()).ed25519;
        return /^[A-Za-z0-9+/]{43}=?$/u.test(fingerprint)
          ? { deviceId, fingerprint, matrixAccessToken } : null;
      } catch {
        return null;
      }
    },
  };
}
