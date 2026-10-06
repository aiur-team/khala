import { ownerFirstName } from '@khala/contracts/m1/participants';
import { CHANNEL_EVENT_TYPE, decodeChannelEvent } from '@khala/contracts/m1/channel-event';
import {
  ClientEvent,
  Direction,
  EventType,
  MatrixEvent,
  MatrixEventEvent,
  MsgType,
  NotificationCountType,
  Preset,
  Room,
  RoomEvent,
  RoomStateEvent,
  SyncState,
  Visibility,
  createClient,
  type MatrixClient,
  type EventTimeline,
} from 'matrix-js-sdk';
import { DecryptionFailureCode, type CryptoApi } from 'matrix-js-sdk/lib/crypto-api';
import {
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
import { attachNameTargets } from './name-targets';
import { checkName } from '@khala/contracts/m1/names';
import type { ChannelNameResult, ChannelNamesPort } from '../../features/channel/ports';
import { encodeMessageContent, projectWireEvent } from './message-wire';
import {
  DEFAULT_LISTENING_MODE, LISTENING_MODE_COMMAND_TYPE, memberListeningMode, type ListeningMode, type ListeningModeCommandContent,
} from '@khala/contracts/m1/listening-mode';
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
import type { BrowserParticipantSession } from './browser-api';
import { sortConversations, type ConversationIndexPort } from './conversations';
import type { SyncStatusPort } from './sync-status';
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
  resolve(userIds: readonly string[], signal?: AbortSignal, roomId?: RoomId, targetParticipantIds?: readonly ParticipantView['participantId'][], session?: BrowserParticipantSession): Promise<ReadonlyMap<string, ParticipantView> | null>;
}>;

function participantSession(active: ActiveClient): BrowserParticipantSession | null {
  const deviceId = active.client.getDeviceId();
  const matrixAccessToken = active.client.getAccessToken();
  return deviceId && matrixAccessToken ? { deviceId, matrixAccessToken } : null;
}

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
    membership: membership === 'join' ? 'joined' : membership === 'ban' ? 'revoked' : membership === 'leave' ? 'left' : 'joining',
    revision: room.getLastLiveEvent()?.getId() ?? `matrix:${room.roomId}`,
  };
  const decoded = decodeRoomSummary(base, limits);
  if (decoded.ok) return decoded.value;
  const withoutUntrustedTitle = decodeRoomSummary({ ...base, title: null }, limits);
  if (withoutUntrustedTitle.ok) return withoutUntrustedTitle.value;
  throw new Error('Matrix room metadata is invalid');
}

/** Preserve an existing server identity; bootstrap failures never block device start. */
export async function ensureCrossSigning(
  crypto: Pick<CryptoApi, 'getCrossSigningStatus' | 'userHasCrossSigningKeys' | 'bootstrapCrossSigning'>,
  userId: string,
  signal?: AbortSignal,
): Promise<'present' | 'foreign' | 'bootstrapped' | 'failed'> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 10_000);
  const bounded = AbortSignal.any([deadline.signal, ...(signal ? [signal] : [])]);
  let onAbort: () => void = () => {};
  try {
    bounded.throwIfAborted();
    const aborted = new Promise<'failed'>(resolve => {
      onAbort = () => resolve('failed');
      bounded.addEventListener('abort', onAbort, { once: true });
    });
    const bootstrap = async (): Promise<'present' | 'foreign' | 'bootstrapped'> => {
      const status = await crypto.getCrossSigningStatus();
      bounded.throwIfAborted();
      const cached = status.privateKeysCachedLocally;
      if (cached.masterKey && cached.selfSigningKey && cached.userSigningKey) return 'present';
      const serverHasKeys = await crypto.userHasCrossSigningKeys(userId, true);
      bounded.throwIfAborted();
      if (serverHasKeys) return 'foreign';
      await crypto.bootstrapCrossSigning({ authUploadDeviceSigningKeys: async (f) => {
        bounded.throwIfAborted();
        await f(null);
      } });
      bounded.throwIfAborted();
      return 'bootstrapped';
    };
    return await Promise.race([bootstrap(), aborted]);
  } catch {
    return 'failed';
  } finally {
    clearTimeout(timer);
    bounded.removeEventListener('abort', onAbort);
  }
}

export function isPreJoinUndecryptable(event: MatrixEvent, joinTs: number | null): boolean {
  return (event.isDecryptionFailure() || event.getType() === 'm.room.encrypted')
    && (event.decryptionFailureReason === DecryptionFailureCode.HISTORICAL_MESSAGE_USER_NOT_JOINED
      || (joinTs !== null && event.getTs() < joinTs));
}

function ownJoinTs(room: Room | null, userId: string | null): number | null {
  const member = userId ? room?.getMember(userId) : null;
  return member?.membership === 'join' ? member.events.member?.getTs() ?? null : null;
}

/** The C4 agent Matrix username: `agent-<ownerHash8>-<rand6>`. */
const AGENT_USER_ID = /^@agent-[0-9a-f]{8}-[a-z0-9]{6}:/u;

type ConversationMember = NonNullable<ConversationSummary['members']>[number];

function conversationMember(userId: string, name: string | undefined): ConversationMember {
  const localpart = userId.slice(1, userId.includes(':') ? userId.indexOf(':') : undefined);
  return { id: userId, kind: AGENT_USER_ID.test(userId) ? 'agent' : 'human', displayName: name && name !== userId ? name : localpart };
}

/** A human's first name, or an agent's label (`Claude · Kevin` → `Claude`). */
function senderLabel(member: ConversationMember): string {
  const label = member.kind === 'agent' ? member.displayName.split(' · ')[0] : member.displayName.trim().split(/\s+/u)[0];
  return label?.trim() || member.displayName;
}

/** Only local, joined encrypted rooms enter the owner conversation index. */
export function projectJoinedEncryptedRooms(client: Pick<MatrixClient, 'getRooms' | 'getUserId'>, limits: ContentLimits): readonly ConversationSummary[] {
  return sortConversations(client.getRooms()
    .filter(candidate => candidate.getMyMembership() === 'join' && candidate.hasEncryptionStateEvent())
    .map(candidate => {
      const summary = roomSummary(candidate, limits);
      const joinTs = ownJoinTs(candidate, client.getUserId());
      const latest = [...candidate.getLiveTimeline().getEvents()].reverse().find(event =>
        !isPreJoinUndecryptable(event, joinTs) && (
          (event.getType() === EventType.RoomMessage && event.getContent().msgtype === MsgType.Text)
          || event.getType() === 'm.room.encrypted'
          || event.isDecryptionFailure()
        ));
      const body = latest?.getType() === EventType.RoomMessage && !latest.isDecryptionFailure()
        ? latest.getClearContent()?.body : null;
      const viewer = client.getUserId();
      const latestId = latest?.getId();
      const unread = viewer && latestId && candidate.hasUserReadEvent(viewer, latestId)
        ? 0 : candidate.getUnreadNotificationCount();
      const sender = latest?.getSender();
      return {
        id: summary.roomId,
        title: summary.title ?? 'Encrypted conversation',
        preview: typeof body === 'string' ? body : null,
        timestamp: latest ? new Date(latest.getTs()).toISOString() : null,
        unreadCount: Number.isSafeInteger(unread) && unread > 0 ? unread : null,
        members: candidate.getJoinedMembers()
          .filter(member => member.userId !== viewer)
          .map(member => conversationMember(member.userId, member.name)),
        ...(sender ? { lastSender: {
          label: senderLabel(conversationMember(sender, candidate.getMember(sender)?.name)),
          isViewer: sender === viewer,
        } } : {}),
      };
    }));
}

/** Persist both the fully-read marker and public receipt for the rendered event. */
export async function markMatrixRoomRead(client: Pick<MatrixClient, 'getRoom' | 'setRoomReadMarkers'>,
  roomId: RoomId, eventId: EventId): Promise<void> {
  const room = client.getRoom(roomId);
  const event = room?.getLiveTimeline().getEvents().find(candidate => candidate.getId() === eventId);
  if (!room || !event || room.getMyMembership() !== 'join') throw new Error('Read event unavailable');
  await client.setRoomReadMarkers(roomId, eventId, event);
  // Do not erase a newer arrival while the server was accepting this receipt.
  if (room.getLiveTimeline().getEvents().at(-1)?.getId() === eventId) {
    room.setUnreadNotificationCount(NotificationCountType.Total, 0);
    room.setUnreadNotificationCount(NotificationCountType.Highlight, 0);
  }
}

/** The homeserver sync is live once the initial sync lands, until it errors, reconnects or stops. */
export function isLiveSync(state: SyncState | null): boolean {
  return state === SyncState.Prepared || state === SyncState.Syncing;
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
  client.on(RoomEvent.Receipt, publish);
  client.on(RoomEvent.Timeline, publish);
  client.on(ClientEvent.Sync, publish);
  publish();
  return () => {
    disposed = true;
    client.off(RoomEvent.Receipt, publish);
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
      { type: EventType.RoomHistoryVisibility, state_key: '', content: { history_visibility: 'shared' } },
      { type: CREATE_EVENT, state_key: '', content: { operation_id: input.operationId } },
    ],
  };
}

export async function waitForEncryptedRoom(client: MatrixClient, roomId: string, signal?: AbortSignal): Promise<Room> {
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
        let stopped = false;
        let crossSigningStarted = false;
        const crossSigningAbort = new AbortController();
        return {
          async identity() {
            const keys = await crypto.getOwnDeviceKeys();
            return { fingerprint: keys.ed25519, created: false };
          },
          async start(signal) {
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
                actor: { ...mapping, displayName: ownerFirstName(principal.verifiedEmail), deviceIds: [input.session.deviceId] },
                generation,
              });
              if (!crossSigningStarted) {
                crossSigningStarted = true;
                // Cross-signing is optional maintenance, after sync and activation.
                void ensureCrossSigning(crypto, session.userId,
                  AbortSignal.any([signal, crossSigningAbort.signal]));
              }
            } catch (error) {
              stopped = true;
              client.stopClient();
              throw error;
            }
          },
          async close() {
            crossSigningAbort.abort();
            if (activeClient()?.client === client) setActive(null);
            // stopClient also closes the crypto store that initRustCrypto opened, so a
            // generation ended before start does not keep its IndexedDB connection.
            if (!stopped) {
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
  const transactionId = event.getUnsigned().transaction_id;
  return projectWireEvent({ type: event.getType(), content: event.getContent(), eventId: eventId as EventId, participant, authorDeviceId,
    clientTxnId: typeof transactionId === 'string' ? transactionId : null, receivedAt,
    ...(event.getType() === 'm.room.member' ? { previousContent: event.getPrevContent() } : {}) }, limits);
}

export async function sendRoomMessage(
  client: Pick<MatrixClient, 'getRoom' | 'sendEvent' | 'getDeviceId'>,
  input: { roomId: RoomId; clientTxnId: string; content: MessageContent },
): Promise<SubstrateEffect<{ eventId: EventId; authorDeviceId: DeviceId }>> {
  try {
    if (!client.getRoom(input.roomId)?.hasEncryptionStateEvent()) return { kind: 'unavailable' };
    const payload = encodeMessageContent(input.content);
    const response = await client.sendEvent(input.roomId, EventType.RoomMessage,
      payload as { msgtype: MsgType.Text | MsgType.Notice; body: string }, input.clientTxnId);
    return {
      kind: 'done',
      value: { eventId: response.event_id as EventId, authorDeviceId: client.getDeviceId() as DeviceId },
    };
  } catch (error) {
    return effectFailure(error);
  }
}

export class MatrixSubstrate implements RoomSubstrate {
  constructor(
    private readonly runtime: MatrixRuntime,
    private readonly limits: ContentLimits,
    private readonly participants: ParticipantResolver,
  ) {}

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

  async room(roomId: RoomId, options?: { signal?: AbortSignal }): Promise<SubstrateRead<RoomSummary>> {
    try {
      const active = this.active();
      const room = await waitForEncryptedRoom(active.client, roomId, options?.signal);
      if (this.runtime.active !== active) return { kind: 'unavailable' };
      return { kind: 'done', value: roomSummary(room, this.limits) };
    } catch { return { kind: 'unavailable' }; }
  }

  async sendEvent(input: Readonly<{ roomId: RoomId; clientTxnId: string; content: MessageContent }>): Promise<SubstrateEffect<{ eventId: EventId; authorDeviceId: DeviceId }>> {
    try {
      return sendRoomMessage(this.active().client, input);
    } catch (error) {
      return effectFailure(error);
    }
  }

  private async events(events: readonly MatrixEvent[], roomId: RoomId): Promise<readonly SubstrateEvent[]> {
    const active = this.active();
    await decryptTimelineEvents(active.client, events);
    if (this.runtime.active !== active) throw new Error('Matrix session changed during timeline decryption');
    const joinTs = ownJoinTs(active.client.getRoom(roomId), active.client.getUserId());
    const visibleEvents = events.filter(event => !isPreJoinUndecryptable(event, joinTs));
    const senders = [...new Set(visibleEvents.flatMap(event => event.getSender() ? [event.getSender()!] : []))];
    const session = participantSession(active);
    if (!session) {
      historyDiagnostic('history_participants');
      throw new Error('Matrix participant session unavailable');
    }
    const mappings = await this.participants.resolve(senders, undefined, roomId, undefined, session).catch(error => {
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
    const projectedEvents = visibleEvents.flatMap(event => {
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
        displayName: sender === active.client.getUserId() ? ownerFirstName(active.principal.verifiedEmail) : mapping.displayName,
        deviceIds: deviceId ? [deviceId] : [],
      };
      const projected = projectMatrixTimelineEvent(event, participant, deviceId ?? null, this.limits);
      return projected ? [projected] : [];
    });
    return attachNameTargets(projectedEvents,
      targetId => this.participants.resolve([], undefined, roomId, [targetId], session),
      () => this.runtime.active === active).catch(error => {
      historyDiagnostic('history_participants');
      throw error;
    });
  }

  async timeline(input: Readonly<{ roomId: RoomId; cursor: string | null; limit: number }>): Promise<SubstrateRead<{ events: readonly SubstrateEvent[]; nextCursor: string | null; revision: string }>> {
    try {
      const active = this.active();
      const room = await waitForEncryptedRoom(active.client, input.roomId);
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

  subscribe(roomId: RoomId, listener: (update: SubstrateUpdate) => void): () => void {
    let disposed = false;
    const active = this.runtime.active;
    if (!active) return () => undefined;
    const abort = new AbortController();
    let publishEpoch = 0;
    const publish = () => {
      if (disposed || this.runtime.active !== active) return;
      const room = active.client.getRoom(roomId);
      if (!room) return;
      const epoch = ++publishEpoch;
      const summary = roomSummary(room, this.limits);
      // Removal must reach the UI even when control no longer resolves this
      // room's participants, so it cannot depend on timeline attribution.
      if (summary.membership === 'left' || summary.membership === 'revoked') {
        listener({ generation: active.generation, room: summary, events: [] });
        return;
      }
      const source = [...room.getLiveTimeline().getEvents()];
      void this.events(source, roomId).then(events => {
        const ignoredEventIds = source.flatMap(event => {
          const id = event.getId();
          return id && event.getType() === CHANNEL_EVENT_TYPE && !event.isDecryptionFailure() && !decodeChannelEvent(event.getContent()).ok
            ? [id as EventId] : [];
        });
        if (!disposed && this.runtime.active === active && epoch === publishEpoch) {
          listener({ generation: active.generation, room: roomSummary(room, this.limits), events, ignoredEventIds });
        }
      }).catch(() => undefined);
    };
    const receive = (_event: MatrixEvent, eventRoom: Room | undefined) => {
      if (eventRoom?.roomId === roomId) publish();
    };
    active.client.on(RoomEvent.Timeline, receive);
    const disposeDecryption = subscribeRoomDecryption(active.client, roomId,
      () => !disposed && this.runtime.active === active, publish);
    const membershipChanged = () => publish();
    active.client.on(RoomEvent.MyMembership, membershipChanged);
    void waitForEncryptedRoom(active.client, roomId, abort.signal).then(publish).catch(() => undefined);
    return () => {
      disposed = true;
      abort.abort();
      active.client.off(RoomEvent.MyMembership, membershipChanged);
      active.client.off(RoomEvent.Timeline, receive);
      disposeDecryption();
    };
  }
}

/** Use the browser SDK invite so its verified identity can share encrypted history. */
export async function inviteWithHistory(client: Pick<MatrixClient, 'getRoom' | 'invite'>, roomId: string, userId: string): Promise<boolean> {
  try {
    const room = client.getRoom(roomId);
    if (!room?.hasEncryptionStateEvent() || !/^@[^:\s]+:\S+$/.test(userId)) return false;
    const membership = room.getMember(userId)?.membership;
    if (membership === 'invite' || membership === 'join') return true;
    await client.invite(roomId, userId);
    return true;
  } catch { return false; }
}

/** The listening mode `userId` reports in its `m.room.member` content. */
export function readListeningMode(client: Pick<MatrixClient, 'getRoom'>, roomId: string, userId: string): ListeningMode {
  return memberListeningMode(client.getRoom(roomId)?.currentState.getStateEvents(EventType.RoomMember, userId)?.getContent());
}

/**
 * Sets the viewer's own name in one channel: their room-scoped `m.room.member`
 * displayname, which every client already reads as the member's name there. The
 * homeserver accepts a member event only from that member, so no one else can set it.
 */
export async function setOwnChannelName(client: Pick<MatrixClient, 'getRoom' | 'getUserId' | 'sendStateEvent'>, roomId: string,
  name: string): Promise<ChannelNameResult> {
  try {
    const checked = checkName(name, 'username');
    if (!checked.ok) return { kind: 'error', code: 'invalid_name', reason: checked.error };
    const userId = client.getUserId();
    const room = client.getRoom(roomId);
    const own = userId ? room?.currentState.getStateEvents(EventType.RoomMember, userId) : null;
    if (!userId || !room || !own || own.getContent().membership !== 'join') return { kind: 'error', code: 'unavailable' };
    const wanted = checked.name.toLowerCase();
    if (room.getJoinedMembers().some(member => member.userId !== userId && member.rawDisplayName.toLowerCase() === wanted)) {
      return { kind: 'error', code: 'name_taken' };
    }
    const send = client.sendStateEvent as unknown as (roomId: string, type: string, content: object, stateKey: string) => Promise<unknown>;
    await send.call(client, roomId, EventType.RoomMember, { ...own.getContent(), membership: 'join', displayname: checked.name }, userId);
    return { kind: 'ok', name: checked.name };
  } catch { return { kind: 'error', code: 'unavailable' }; }
}

/** When `userId` took its current name in `roomId`: the time of its latest membership event. */
export function memberSince(client: Pick<MatrixClient, 'getRoom'>, roomId: string, userId: string): number | null {
  return client.getRoom(roomId)?.currentState.getStateEvents(EventType.RoomMember, userId)?.getTs() ?? null;
}

/** Sends the owner's encrypted listening-mode command to one agent. */
export async function sendListeningMode(client: Pick<MatrixClient, 'getRoom' | 'sendEvent'>, roomId: string, userId: string,
  mode: ListeningMode, txnId: string): Promise<'sent' | 'failed'> {
  try {
    if (!client.getRoom(roomId)?.hasEncryptionStateEvent() || !/^@[^:\s]+:\S+$/.test(userId)) return 'failed';
    const send = client.sendEvent as unknown as (roomId: string, type: string, content: object, txnId: string) => Promise<unknown>;
    const content: ListeningModeCommandContent = { v: 1, agent: userId, mode };
    await send.call(client, roomId, LISTENING_MODE_COMMAND_TYPE, content, txnId);
    return 'sent';
  } catch { return 'failed'; }
}

export type MatrixBrowserPorts = Readonly<{
  device: DevicePort;
  room: RoomPort & Pick<ChannelService, 'observeEntries'>;
  conversations: ConversationIndexPort;
  syncStatus: SyncStatusPort;
  inviteAgent(roomId: RoomId, userId: string): Promise<boolean>;
  /** Current SDK membership, independent of timeline attribution readiness. */
  isJoined(roomId: RoomId): boolean;
  listeningMode(roomId: RoomId, userId: string): ListeningMode;
  /** Calls `listener` whenever a member event lands in `roomId`. */
  subscribeListeningModes(roomId: RoomId, listener: () => void): () => void;
  setListeningMode(roomId: RoomId, userId: string, mode: ListeningMode, txnId: string): Promise<'sent' | 'failed'>;
  participant(): ParticipantView | null;
  channelNames: ChannelNamesPort;
  memberSince(roomId: RoomId, userId: string): number | null;
  roomParticipants(roomId: RoomId, signal?: AbortSignal): Promise<readonly ParticipantView[] | null>;
}>;

/** Binds the selected Matrix SDK to KHA-111/112 without exposing it to UI controllers. */
export function createMatrixBrowserPorts(input: Readonly<{
  identity: IdentityPort;
  credentials: CredentialSource;
  limits: ContentLimits;
  participants: ParticipantResolver;
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
  const substrate = new MatrixSubstrate(runtime, input.limits, input.participants);
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
    async markRead(ownerId, generation, roomId, eventId) {
      const active = runtime.active;
      const view = device.current();
      if (!active || active.principal.ownerId !== ownerId || view.state !== 'ready'
        || view.generation !== generation || active.generation !== generation) throw new Error('Read session unavailable');
      await markMatrixRoomRead(active.client, roomId, eventId);
    },
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

  const syncStatus: SyncStatusPort = {
    live(ownerId, generation) {
      const active = runtime.active;
      const view = device.current();
      if (!active || active.principal.ownerId !== ownerId || view.state !== 'ready' || view.generation !== generation || active.generation !== generation) return false;
      return isLiveSync(active.client.getSyncState());
    },
    subscribe(ownerId, generation, listener) {
      const active = runtime.active;
      if (!active || active.principal.ownerId !== ownerId || active.generation !== generation) return () => undefined;
      const publish = () => { if (runtime.active === active) listener(); };
      active.client.on(ClientEvent.Sync, publish);
      return () => { active.client.off(ClientEvent.Sync, publish); };
    },
  };

  return {
    inviteAgent: (roomId, userId) => runtime.active
      ? inviteWithHistory(runtime.active.client, roomId, userId) : Promise.resolve(false),
    isJoined: roomId => runtime.active?.client.getRoom(roomId)?.getMyMembership() === 'join',
    listeningMode: (roomId, userId) => runtime.active
      ? readListeningMode(runtime.active.client, roomId, userId) : DEFAULT_LISTENING_MODE,
    subscribeListeningModes(roomId, listener) {
      const active = runtime.active;
      if (!active) return () => undefined;
      const publish = (event: MatrixEvent) => {
        if (runtime.active === active && event.getRoomId() === roomId && event.getType() === EventType.RoomMember) listener();
      };
      active.client.on(RoomStateEvent.Events, publish);
      return () => { active.client.off(RoomStateEvent.Events, publish); };
    },
    setListeningMode: (roomId, userId, mode, txnId) => runtime.active
      ? sendListeningMode(runtime.active.client, roomId, userId, mode, txnId) : Promise.resolve('failed'),
    device, room, conversations, syncStatus, participant: () => runtime.active?.actor ?? null,
    channelNames: { setOwnName: (roomId, name) => runtime.active
      ? setOwnChannelName(runtime.active.client, roomId, name) : Promise.resolve({ kind: 'error', code: 'unavailable' }) },
    memberSince: (roomId, userId) => runtime.active ? memberSince(runtime.active.client, roomId, userId) : null,
    async roomParticipants(roomId, signal) {
      const active = runtime.active;
      if (!active || !active.client.getRoom(roomId)?.hasEncryptionStateEvent()) return null;
      try {
        // Lazy-loaded rooms hold only some membership events; the name prompt orders members by them (memberSince).
        try { await active.client.getRoom(roomId)?.loadMembersIfNeeded(); } catch { /* The prompt then orders unknown members last. */ }
        const joined = await active.client.getJoinedRoomMembers(roomId);
        if (signal?.aborted || runtime.active !== active) return null;
        const userIds = Object.keys(joined.joined);
        const session = participantSession(active);
        if (!session) return null;
        const mapping = await input.participants.resolve(userIds, signal, roomId, undefined, session);
        if (!mapping || !userIds.every(userId => mapping.has(userId)) || signal?.aborted || runtime.active !== active) return null;
        return userIds.map(userId => mapping.get(userId)!).filter(Boolean);
      } catch { return null; }
    },
  };
}
