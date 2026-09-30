/// <reference lib="dom" />
// Browser half of the owner connector's Matrix device. matrix-js-sdk's supported durable
// Rust crypto store is IndexedDB; this page is a private local sidecar, never a model surface.
import { ClientEvent, EventType, MatrixEvent, MsgType, RoomEvent, SyncState, createClient, type MatrixClient } from 'matrix-js-sdk';

type OpenInput = Readonly<{
  baseUrl: string; userId: string; deviceId: string; accessToken: string;
  roomId: string; storeName: string;
}>;
type BrowserEvent = Readonly<{
  eventId: string; roomId: string; senderUserId: string; senderDeviceId: string | null;
  receivedAt: string;
  body: string | null; agentParticipantId: string | null; nameSnapshot?: boolean; nameSourceEventId?: string | null;
  failure: 'missing_keys' | 'withheld_unverified' | 'withheld' | 'decrypt_failed' | 'unsupported' | null;
}>;
type SyncPage = Readonly<{ events: readonly BrowserEvent[]; nextCursor: string; limited: boolean }>;

declare global {
  interface Window {
    khalaMatrix: MatrixBrowserApi;
    khalaHint?: (lost?: boolean) => void;
  }
}

type MatrixBrowserApi = Readonly<{
  open(input: OpenInput): Promise<{ fingerprint: string; deviceId: string }>;
  trustPeer(userId: string, deviceId: string, expectedEd25519: string): Promise<void>;
  removeOwnDevice(expectedCurve25519: string): Promise<'removed' | 'replaced' | 'reauthentication_required' | 'forbidden' | 'unavailable'>;
  discardOutboundSession(): Promise<boolean>;
  authorize(): Promise<'ok' | 'revoked' | 'expired' | 'unavailable'>;
  read(cursor: string | null, limit: number): Promise<SyncPage>;
  members(): Promise<readonly string[]>;
  send(clientTxnId: string, body: string): Promise<{ eventId: string }>;
  close(): Promise<void>;
}>;

let client: MatrixClient | null = null;
let active: OpenInput | null = null;
let releaseLock: (() => void) | null = null;
let lockComplete: Promise<unknown> | null = null;
let timelineHandler: ((...args: unknown[]) => void) | null = null;
let syncHandler: ((...args: unknown[]) => void) | null = null;

function failure(reason: unknown): BrowserEvent['failure'] {
  if (reason === 'MEGOLM_UNKNOWN_INBOUND_SESSION_ID') return 'missing_keys';
  if (reason === 'MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE') return 'withheld_unverified';
  if (reason === 'MEGOLM_KEY_WITHHELD') return 'withheld';
  return 'decrypt_failed';
}

async function syncReady(matrix: MatrixClient): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => done(() => reject(new Error('matrix_sync_timeout'))), 30_000);
    const onSync = (state: SyncState) => {
      if (state === SyncState.Prepared || state === SyncState.Syncing) done(resolve);
      if (state === SyncState.Error || state === SyncState.Stopped) done(() => reject(new Error('matrix_sync_unavailable')));
    };
    const done = (result: () => void) => { if (settled) return; settled = true; clearTimeout(timeout); matrix.off(ClientEvent.Sync, onSync); result(); };
    matrix.on(ClientEvent.Sync, onSync);
    void Promise.resolve(matrix.startClient({ initialSyncLimit: 50 })).catch(error => done(() => reject(error)));
  });
}

async function eventFromWire(raw: Record<string, unknown>): Promise<BrowserEvent | null> {
  const matrix = client;
  if (!matrix || !active) throw new Error('matrix_closed');
  const eventId = raw.event_id;
  const roomId = raw.room_id;
  const sender = raw.sender;
  if (typeof eventId !== 'string' || typeof roomId !== 'string' || typeof sender !== 'string') return null;
  if (roomId !== active.roomId || raw.type !== 'm.room.encrypted') return null;
  const placeholder = (reason: BrowserEvent['failure'], deviceId: string | null = null): BrowserEvent => ({
    eventId, roomId, senderUserId: sender, senderDeviceId: deviceId,
    receivedAt: new Date(Number(raw.origin_server_ts) || 0).toISOString(),
    body: null, agentParticipantId: null, failure: reason,
  });
  const event = new MatrixEvent(raw);
  try { await matrix.decryptEventIfNeeded(event); } catch { return placeholder('decrypt_failed'); }
  if (event.isDecryptionFailure()) return placeholder(failure(event.decryptionFailureReason));
  const content = event.getContent();
  if (event.getType() !== 'm.room.message' || typeof content.body !== 'string'
    || (content.msgtype !== MsgType.Text && content.msgtype !== MsgType.Notice)) return placeholder('unsupported');
  if (content.msgtype === MsgType.Notice && typeof content['com.khala.agent_participant_id'] !== 'string')
    return placeholder('unsupported');
  const crypto = matrix.getCrypto();
  if (!crypto) return placeholder('decrypt_failed');
  const senderKey = event.getSenderKey();
  const claimed = event.getClaimedEd25519Key();
  if (!senderKey || !claimed) return placeholder('decrypt_failed');
  const devices = (await crypto.getUserDeviceInfo([sender], true)).get(sender);
  const matches = [...(devices?.values() ?? [])].filter(device => device.getIdentityKey() === senderKey && device.getFingerprint() === claimed);
  if (matches.length !== 1) return placeholder('decrypt_failed');
  const device = matches[0]!;
  const status = await crypto.getDeviceVerificationStatus(sender, device.deviceId);
  if (!status?.isVerified()) return placeholder('withheld_unverified', device.deviceId);
  return { eventId, roomId, senderUserId: sender, senderDeviceId: device.deviceId, body: content.body,
    receivedAt: new Date(event.getTs()).toISOString(),
    agentParticipantId: content.msgtype === MsgType.Notice ? content['com.khala.agent_participant_id'] as string : null,
    ...(content['com.khala.name_snapshot'] === true ? { nameSnapshot: true, nameSourceEventId: content['com.khala.name_source_event_id'] as string | null } : {}), failure: null };
}

window.khalaMatrix = {
  async open(input) {
    if (client || releaseLock) throw new Error('matrix_already_open');
    if (!input.storeName || !input.userId || !input.deviceId || !input.accessToken) throw new Error('matrix_invalid_input');
    let settled = false;
    let accepted!: () => void;
    let refused!: (error: unknown) => void;
    const ready = new Promise<void>((yes, no) => { accepted = yes; refused = no; });
    lockComplete = navigator.locks.request(`khala-matrix:${input.storeName}`, { ifAvailable: true }, async lock => {
      if (!lock) { refused(new Error('matrix_device_locked')); return; }
      let matrix: MatrixClient | null = null;
      try {
        matrix = createClient({ baseUrl: input.baseUrl, userId: input.userId, deviceId: input.deviceId,
          accessToken: input.accessToken, localTimeoutMs: 30_000 });
        await matrix.initRustCrypto({ useIndexedDB: true, cryptoDatabasePrefix: input.storeName });
        const keys = await matrix.getCrypto()?.getOwnDeviceKeys();
        if (!keys?.ed25519) throw new Error('matrix_identity_unavailable');
        const marker = `khala-matrix-identity:${input.storeName}`;
        const previous = localStorage.getItem(marker);
        if (previous && previous !== JSON.stringify({ userId: input.userId, deviceId: input.deviceId, fingerprint: keys.ed25519 }))
          throw new Error('matrix_identity_changed');
        localStorage.setItem(marker, JSON.stringify({ userId: input.userId, deviceId: input.deviceId, fingerprint: keys.ed25519 }));
        matrix.getCrypto()!.globalBlacklistUnverifiedDevices = true;
        await syncReady(matrix);
        client = matrix;
        active = input;
        timelineHandler = () => { void window.khalaHint?.(); };
        syncHandler = (state: unknown) => { void window.khalaHint?.(state === SyncState.Error || state === SyncState.Stopped); };
        matrix.on(RoomEvent.Timeline, timelineHandler);
        matrix.on(ClientEvent.Sync, syncHandler);
        settled = true;
        accepted();
        await new Promise<void>(resolve => { releaseLock = resolve; });
      } catch (error) {
        if (!settled) refused(error);
      } finally {
        matrix?.stopClient();
        client = null;
        active = null;
        releaseLock = null;
      }
    });
    await ready;
    return { fingerprint: (await client!.getCrypto()!.getOwnDeviceKeys()).ed25519, deviceId: input.deviceId };
  },
  async trustPeer(userId, deviceId, expectedEd25519) {
    const crypto = client?.getCrypto();
    if (!crypto) throw new Error('matrix_closed');
    const device = (await crypto.getUserDeviceInfo([userId], true)).get(userId)?.get(deviceId);
    if (!device || device.getFingerprint() !== expectedEd25519) throw new Error('matrix_fingerprint_mismatch');
    await crypto.setDeviceVerified(userId, deviceId, true);
    if (!(await crypto.getDeviceVerificationStatus(userId, deviceId))?.isVerified()) throw new Error('matrix_verification_failed');
    if (active) await crypto.forceDiscardSession(active.roomId);
  },
  async removeOwnDevice(expectedCurve25519) {
    const matrix = client;
    const opened = active;
    const crypto = matrix?.getCrypto();
    if (!matrix || !opened || !crypto) return 'unavailable';
    const own = await crypto.getOwnDeviceKeys();
    if (own.curve25519 !== expectedCurve25519) return 'replaced';
    const published = (await crypto.getUserDeviceInfo([opened.userId], true)).get(opened.userId)?.get(opened.deviceId);
    if (!published || published.getIdentityKey() !== expectedCurve25519) return 'replaced';
    try {
      await matrix.deleteDevice(opened.deviceId);
      return 'removed';
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'errcode' in error ? error.errcode : null;
      const status = typeof error === 'object' && error !== null && 'httpStatus' in error ? error.httpStatus : null;
      if (code === 'M_UNAUTHORIZED' || status === 401) return 'reauthentication_required';
      if (code === 'M_FORBIDDEN' || status === 403) return 'forbidden';
      return 'unavailable';
    }
  },
  async discardOutboundSession() {
    const crypto = client?.getCrypto();
    if (!crypto || !active) return false;
    try { await crypto.forceDiscardSession(active.roomId); return true; }
    catch { return false; }
  },
  async authorize() {
    if (!active) return 'unavailable';
    try {
      const response = await fetch(`${active.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(active.roomId)}/state/m.room.member/${encodeURIComponent(active.userId)}`, {
        headers: { Authorization: `Bearer ${active.accessToken}` },
      });
      if (response.status === 401) return 'expired';
      if (response.status === 403 || response.status === 404) return 'revoked';
      if (!response.ok) return 'unavailable';
      const body: unknown = await response.json();
      return typeof body === 'object' && body !== null && 'membership' in body && body.membership === 'join' ? 'ok' : 'revoked';
    } catch { return 'unavailable'; }
  },
  async read(cursor, limit) {
    if (!active || !client) throw new Error('matrix_closed');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('matrix_invalid_limit');
    const query = new URLSearchParams({ timeout: '0', filter: JSON.stringify({ room: { rooms: [active.roomId], timeline: { limit } } }) });
    if (cursor !== null) query.set('since', cursor);
    const response = await fetch(`${active.baseUrl}/_matrix/client/v3/sync?${query}`, {
      headers: { Authorization: `Bearer ${active.accessToken}` },
    });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'matrix_authority_lost' : 'matrix_unavailable');
    const body = await response.json() as { next_batch?: unknown; rooms?: { join?: Record<string, { timeline?: { events?: Record<string, unknown>[]; limited?: boolean } }> } };
    if (typeof body.next_batch !== 'string') throw new Error('matrix_sync_invalid');
    const timeline = body.rooms?.join?.[active.roomId]?.timeline;
    const events: BrowserEvent[] = [];
    for (const raw of timeline?.events ?? []) {
      const event = await eventFromWire({ ...raw, room_id: active.roomId });
      if (event) events.push(event);
    }
    return { events, nextCursor: body.next_batch, limited: timeline?.limited === true };
  },
  async members() {
    if (!active || !client) throw new Error('matrix_closed');
    const result = await client.getJoinedRoomMembers(active.roomId);
    return Object.keys(result.joined);
  },
  async send(clientTxnId, body) {
    if (!active || !client) throw new Error('matrix_closed');
    if (!/^[A-Za-z0-9_-]{8,128}$/u.test(clientTxnId) || typeof body !== 'string' || body.length === 0
      || new TextEncoder().encode(body).length > 64 * 1024) throw new Error('matrix_invalid_send');
    if (await this.authorize() !== 'ok') throw new Error('matrix_authority_lost');
    const room = client.getRoom(active.roomId);
    if (!room?.hasEncryptionStateEvent()) throw new Error('matrix_room_not_encrypted');
    const response = await client.sendEvent(active.roomId, EventType.RoomMessage,
      { msgtype: MsgType.Text, body }, clientTxnId);
    if (typeof response.event_id !== 'string') throw new Error('matrix_send_unknown');
    return { eventId: response.event_id };
  },
  async close() {
    const matrix = client;
    if (matrix && timelineHandler) matrix.off(RoomEvent.Timeline, timelineHandler);
    if (matrix && syncHandler) matrix.off(ClientEvent.Sync, syncHandler);
    matrix?.stopClient();
    releaseLock?.();
    await lockComplete;
  },
};
