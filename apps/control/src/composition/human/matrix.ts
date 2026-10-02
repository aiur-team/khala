import { createHash, createHmac } from 'node:crypto';
import { createAgentBindingStore } from '../../agent-bootstrap/store';
import { createOwnerRoomIndex } from '../../agent-bootstrap/owner-room-index';
import { agentMatrixIdentity } from '../agent/matrix-admission';
import { agentOwnerRecordKey, decodeAgentOwnerRecord, ownerFirstName, type AgentOwnerRecord, type Participant } from '@khala/contracts/m1/participants';
import { decodeOwnerId, decodeRoomId } from '@khala/contracts/messaging/index';
import { ownerFromMatrixUserId, ownerMatrixLocalpart, ownerMatrixUserId } from './matrix-identity';
import type {
  AuthPrincipal,
  CallOptions,
  ControlStore,
  DeviceId,
  OwnerId,
  ParticipantId,
  RoomId,
  RoomSummary,
} from '@khala/contracts/messaging/index';
import type { ChannelCreateSubstrate } from '@khala/messaging/channel-create/adapter';
import type { MessagingAccountDirectory } from '../../auth/index';
import type {
  AdmissionGateway,
  GatewayAdmission,
  GatewayInspection,
  GatewayLookup,
  GatewayRequest,
  InvitationAuthority,
} from '../../invitations/index';

type Fetch = typeof globalThis.fetch;

export type MatrixHumanOptions = Readonly<{
  homeserverOrigin: string;
  allowInsecureLoopback?: boolean;
  serverName: string;
  registrationSharedSecret: string;
  registrationIngressToken?: string | null;
  passwordDerivationSecret: string;
  store: ControlStore;
  fetch?: Fetch;
  timeoutMs?: number;
}>;

export type MatrixBrowserSession = Readonly<{
  homeserverOrigin: string;
  userId: string;
  accessToken: string;
  deviceId: DeviceId;
  publishedFingerprint: string | null;
}>;

/** Ephemeral bearer accepted only after the browser sender verifier succeeds. */
export type VerifiedBrowserReadSession = Readonly<{ accessToken: string; matrixUserId: string }>;

export interface MatrixSessionIssuer {
  issue(principal: AuthPrincipal, deviceId: DeviceId, options?: CallOptions): Promise<
    Readonly<{ kind: 'ok'; session: MatrixBrowserSession }>
    | Readonly<{ kind: 'unavailable' }>
  >;
  resolveParticipants(userIds: readonly string[], options?: CallOptions): Promise<
    Readonly<{ kind: 'ok'; participants: readonly MatrixParticipant[] }>
    | Readonly<{ kind: 'unavailable' }>
  >;
  resolveRoomParticipants(ownerId: OwnerId, roomId: RoomId, userIds: readonly string[], options?: CallOptions, targetParticipantIds?: readonly ParticipantId[], browserSession?: VerifiedBrowserReadSession): Promise<
    Readonly<{ kind: 'ok'; participants: readonly MatrixParticipant[] }>
    | Readonly<{ kind: 'forbidden' | 'unavailable'; localDiagnostic?: Readonly<{ stage: 'membership' | 'control_login' | 'joined_members'; status: number }> }>
  >;
}

export type MatrixParticipant = Participant;

export type MatrixHumanServices = Readonly<{
  directory: MessagingAccountDirectory;
  sessions: MatrixSessionIssuer;
  authority: InvitationAuthority;
  gateway: AdmissionGateway;
  /** Recheck a bound owner's live Matrix membership without accepting a caller-supplied principal. */
  inspectOwnerMembership(ownerId: OwnerId, roomId: RoomId): Promise<GatewayInspection>;
  /** Inspect one published owner device key using the server's bounded control session. */
  inspectOwnerDeviceKey(ownerId: OwnerId, deviceId: DeviceId, fingerprint: string): Promise<'matched' | 'missing' | 'mismatch' | 'unavailable'>;
  /** Read the durable creator authority for a room; null is never ownership proof. */
  inspectRoomAuthority(roomId: RoomId): Promise<OwnerId | null>;
  /** Only the owner approved by the channel-create workflow may select this substrate. */
  channelCreateFor(ownerId: OwnerId): ChannelCreateSubstrate;
  /** Inventory only: callers must hold/fence adapter sends before trusting a rotation result. */
  inspectRoomSenderDevices(ownerId: OwnerId, roomId: RoomId, call?: CallOptions): Promise<
    Readonly<{ kind: 'ok'; senders: readonly MatrixRoomSenderDevice[] }> | Readonly<{ kind: 'unavailable' }>
  >;
}>;

export type MatrixRoomSenderDevice = Readonly<{ matrixUserId: string; deviceId: string; curve25519: string }>;

type MatrixLogin = Readonly<{ userId: string; accessToken: string; deviceId: DeviceId }>;

function exactHttpsOrigin(value: string, allowInsecureLoopback = false): string {
  const url = new URL(value);
  const loopback = allowInsecureLoopback && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || loopback) || url.username || url.password || url.origin !== value
    || url.pathname !== '/' || url.search || url.hash) throw new Error('Matrix origin must be an exact https origin');
  return url.origin;
}

function validateServerName(value: string): string {
  if (!/^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/u.test(value) || value.length > 255) {
    throw new Error('Matrix server name is invalid');
  }
  return value;
}

function requireSecret(value: string, name: string): string {
  if (Buffer.byteLength(value, 'utf8') < 32) throw new Error(`${name} must be at least 32 bytes`);
  return value;
}

function safeObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function body(response: Response): Promise<Record<string, unknown> | null> {
  try { return safeObject(await response.json()); } catch { return null; }
}

function matrixRoom(roomId: RoomId, title: string | null): RoomSummary {
  return { roomId, title, membership: 'joined', revision: `matrix:${roomId}` };
}

export function createMatrixHumanServices(options: MatrixHumanOptions): MatrixHumanServices {
  const homeserverOrigin = exactHttpsOrigin(options.homeserverOrigin, options.allowInsecureLoopback);
  const serverName = validateServerName(options.serverName);
  const registrationSecret = requireSecret(options.registrationSharedSecret, 'Matrix registration shared secret');
  const registrationIngressToken = options.registrationIngressToken
    ? requireSecret(options.registrationIngressToken, 'Matrix registration ingress token') : null;
  const passwordSecret = requireSecret(options.passwordDerivationSecret, 'Matrix password derivation secret');
  const fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const controlSessions = new Map<OwnerId, Readonly<{ session: MatrixLogin; expiresAt: number }>>();
  const controlLogins = new Map<OwnerId, Promise<MatrixLogin | null>>();
  const controlRetryAfter = new Map<OwnerId, number>();
  const loginRetryAfter = new Map<string, number>();
  type LocalParticipantDiagnostic = { stage: 'membership' | 'control_login' | 'joined_members'; status: number };

  type RoomAuthorityRecord = Readonly<{ v: 1; roomId: string; ownerId: string }>;
  const authorityKey = (roomId: RoomId) => `matrix.room-authority.v1.${createHash('sha256').update(roomId).digest('hex')}`;
  const validAuthority = (value: unknown, roomId: RoomId): value is RoomAuthorityRecord => {
    const record = safeObject(value);
    return record?.v === 1 && record.roomId === roomId && typeof record.ownerId === 'string' && decodeOwnerId(record.ownerId).ok;
  };
  async function rememberAuthority(roomId: RoomId, ownerId: OwnerId, call?: CallOptions): Promise<boolean> {
    const key = authorityKey(roomId);
    try {
      const current = await options.store.read<RoomAuthorityRecord>(key, call);
      if (current.kind === 'record') return validAuthority(current.record.value, roomId);
      if (current.kind !== 'absent') return false;
      const value: RoomAuthorityRecord = { v: 1, roomId, ownerId };
      const written = await options.store.compareAndSet({
        key,
        expectedRevision: null,
        operationId: `matrix.room-authority.claim.${createHash('sha256').update(roomId).update('\0').update(ownerId).digest('hex')}`,
        next: { value, expiresAt: null },
      }, call);
      if (written.kind === 'applied') return true;
      if (written.kind === 'conflict' && written.current) return validAuthority(written.current.value, roomId);
      if (written.kind === 'outcome_unknown') {
        const reconciled = await options.store.read<RoomAuthorityRecord>(key, call);
        return reconciled.kind === 'record' && validAuthority(reconciled.record.value, roomId);
      }
      return false;
    } catch {
      return false;
    }
  }
  async function roomAuthority(roomId: RoomId, call?: CallOptions): Promise<OwnerId | null> {
    try {
      const current = await options.store.read<RoomAuthorityRecord>(authorityKey(roomId), call);
      if (current.kind !== 'record' || !validAuthority(current.record.value, roomId)) return null;
      return current.record.value.ownerId as OwnerId;
    } catch {
      return null;
    }
  }

  const accountId = (ownerId: OwnerId) => ownerMatrixUserId(ownerId, serverName);
  const participantFor = (userId: string): (Extract<Participant, { kind: 'human' }> & { ownerId: OwnerId; participantId: ParticipantId }) | null => {
    const ownerId = ownerFromMatrixUserId(userId, serverName);
    if (!ownerId) return null;
    return {
      matrixUserId: userId,
      participantId: `human_${createHash('sha256').update(userId).digest('hex').slice(0, 40)}` as ParticipantId,
      ownerId,
      displayName: userId,
      kind: 'human',
    };
  };
  const agentParticipantId = (userId: string) => `agent_${createHash('sha256').update(userId).digest('hex').slice(0, 40)}`;
  const displayName = (value: unknown, userId: string): string => typeof value === 'string'
    && value.length >= 1 && value.length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) ? value : userId;
  async function readAgentOwner(userId: string, call?: CallOptions): Promise<AgentOwnerRecord | null> {
    try {
      const read = await options.store.read(agentOwnerRecordKey(userId), call);
      if (read.kind !== 'record') return null;
      const decoded = decodeAgentOwnerRecord(read.record.value);
      return decoded.ok && decoded.value.matrixUserId === userId ? decoded.value : null;
    } catch { return null; }
  }
  const password = (ownerId: OwnerId) => createHmac('sha256', passwordSecret)
    .update('khala-matrix-password-v1\0')
    .update(ownerId)
    .digest('base64url');

  async function request(path: string, init: RequestInit = {}, call?: CallOptions): Promise<Response> {
    const signal = AbortSignal.any([
      AbortSignal.timeout(timeoutMs),
      ...(call?.signal ? [call.signal] : []),
    ]);
    const response = await fetch(`${homeserverOrigin}${path}`, { ...init, signal });
    if (response.status === 401) {
      const authorization = new Headers(init.headers).get('authorization');
      for (const [ownerId, cached] of controlSessions) {
        if (authorization === `Bearer ${cached.session.accessToken}`) controlSessions.delete(ownerId);
      }
    }
    return response;
  }

  async function exists(ownerId: OwnerId, call?: CallOptions): Promise<'found' | 'absent' | 'unavailable'> {
    try {
      const response = await request(`/_matrix/client/v3/profile/${encodeURIComponent(accountId(ownerId))}`, {}, call);
      if (response.status === 200) return 'found';
      const value = await body(response);
      // Synapse's profile endpoint returns M_UNKNOWN for an unregistered user,
      // with this exact error. Other 404s still fail closed.
      const missingProfile = value?.errcode === 'M_NOT_FOUND'
        || (value?.errcode === 'M_UNKNOWN' && value.error === 'No row found (profiles)');
      return response.status === 404 && missingProfile ? 'absent' : 'unavailable';
    } catch {
      return 'unavailable';
    }
  }

  async function register(ownerId: OwnerId, call?: CallOptions): Promise<'created' | 'unavailable' | 'outcome_unknown'> {
    try {
      const ingressHeaders = registrationIngressToken ? { 'X-Khala-Registration-Ingress': registrationIngressToken } : {};
      const nonceResponse = await request('/_synapse/admin/v1/register', { headers: { accept: 'application/json', ...ingressHeaders } }, call);
      const nonceBody = await body(nonceResponse);
      if (nonceResponse.status !== 200 || typeof nonceBody?.nonce !== 'string') return 'unavailable';
      const username = ownerMatrixLocalpart(ownerId);
      const adminFlag = 'notadmin';
      const mac = createHmac('sha1', registrationSecret)
        .update(nonceBody.nonce).update('\0')
        .update(username).update('\0')
        .update(password(ownerId)).update('\0')
        .update(adminFlag)
        .digest('hex');
      const response = await request('/_synapse/admin/v1/register', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', ...ingressHeaders },
        body: JSON.stringify({ nonce: nonceBody.nonce, username, password: password(ownerId), admin: false, mac }),
      }, call);
      const value = await body(response);
      if (response.status === 200 && value?.user_id === accountId(ownerId)) return 'created';
      if (response.status === 400 && value?.errcode === 'M_USER_IN_USE') {
        return await exists(ownerId, call) === 'found' ? 'created' : 'unavailable';
      }
      return response.status >= 500 ? 'outcome_unknown' : 'unavailable';
    } catch (error) {
      return call?.signal?.aborted || error instanceof DOMException && error.name === 'AbortError'
        ? 'unavailable'
        : 'outcome_unknown';
    }
  }

  async function login(ownerId: OwnerId, deviceId: DeviceId, call?: CallOptions, diagnostic?: LocalParticipantDiagnostic): Promise<MatrixLogin | null> {
    const loginKey = `${ownerId}\0${deviceId}`;
    if (Date.now() < (loginRetryAfter.get(loginKey) ?? 0)) {
      if (diagnostic) { diagnostic.stage = 'control_login'; diagnostic.status = 429; }
      return null;
    }
    try {
      const userId = accountId(ownerId);
      const response = await request('/_matrix/client/v3/login', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: userId },
          password: password(ownerId),
          device_id: deviceId,
          initial_device_display_name: 'Khala Web',
        }),
      }, call);
      if (diagnostic) { diagnostic.stage = 'control_login'; diagnostic.status = response.status; }
      if (response.status === 429) {
        const retry = await body(response);
        const retryMs = typeof retry?.retry_after_ms === 'number' && Number.isFinite(retry.retry_after_ms)
          ? Math.max(0, Math.min(300_000, retry.retry_after_ms)) : 5_000;
        for (const [key, until] of loginRetryAfter) if (until <= Date.now()) loginRetryAfter.delete(key);
        if (loginRetryAfter.size >= 256) loginRetryAfter.delete(loginRetryAfter.keys().next().value!);
        loginRetryAfter.set(loginKey, Date.now() + retryMs);
        return null;
      }
      if (response.status !== 200) return null;
      loginRetryAfter.delete(loginKey);
      const value = await body(response);
      if (value?.user_id !== userId || value.device_id !== deviceId || typeof value.access_token !== 'string') return null;
      return { userId, accessToken: value.access_token, deviceId };
    } catch {
      return null;
    }
  }

  async function publishedFingerprint(session: MatrixLogin, call?: CallOptions): Promise<string | null> {
    try {
      const response = await request('/_matrix/client/v3/keys/query', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ device_keys: { [session.userId]: [session.deviceId] } }),
      }, call);
      if (response.status !== 200) return null;
      const value = await body(response);
      const devices = safeObject(safeObject(value?.device_keys)?.[session.userId]);
      const device = safeObject(devices?.[session.deviceId]);
      const keys = safeObject(device?.keys);
      const fingerprint = keys?.[`ed25519:${session.deviceId}`];
      return typeof fingerprint === 'string' ? fingerprint : null;
    } catch {
      return null;
    }
  }

  async function inspectOwnerDeviceKey(ownerId: OwnerId, deviceId: DeviceId,
    fingerprint: string): Promise<'matched' | 'missing' | 'mismatch' | 'unavailable'> {
    const session = await controlLogin(ownerId);
    if (!session || session.userId !== accountId(ownerId)) return 'unavailable';
    try {
      const response = await request('/_matrix/client/v3/keys/query', {
        method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json',
          authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify({ device_keys: { [session.userId]: [deviceId] } }),
      });
      if (response.status !== 200) return 'unavailable';
      const value = await body(response);
      const failures = value?.failures === undefined ? {} : safeObject(value.failures);
      const users = safeObject(value?.device_keys);
      if (!failures || Object.keys(failures).length || !users) return 'unavailable';
      if (!Object.hasOwn(users, session.userId)) return 'missing';
      const devices = safeObject(users[session.userId]);
      if (!devices) return 'unavailable';
      if (!Object.hasOwn(devices, deviceId)) return 'missing';
      const device = safeObject(devices[deviceId]);
      if (!device || device.user_id !== session.userId || device.device_id !== deviceId) return 'unavailable';
      const keys = safeObject(device.keys);
      const observed = keys?.[`ed25519:${deviceId}`];
      return typeof observed === 'string' ? observed === fingerprint ? 'matched' : 'mismatch' : 'unavailable';
    } catch { return 'unavailable'; }
  }

  const directory: MessagingAccountDirectory = {
    async lookup(externalId, call) {
      const result = await exists(externalId, call);
      if (result === 'found') return { kind: 'found', accountId: accountId(externalId) };
      return result === 'absent' ? { kind: 'absent' } : { kind: 'unavailable' };
    },
    async create(externalId, call) {
      const result = await register(externalId, call);
      if (result === 'created') return { kind: 'created', accountId: accountId(externalId) };
      return { kind: result };
    },
  };

  const sessions: MatrixSessionIssuer = {
    async issue(principal, deviceId, call) {
      const session = await login(principal.ownerId, deviceId, call);
      if (session === null) return { kind: 'unavailable' };
      try {
        const path = `/_matrix/client/v3/profile/${encodeURIComponent(session.userId)}/displayname`;
        const headers = { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json' };
        const profile = await request(path, { headers }, call);
        if (profile.status !== 200) return { kind: 'unavailable' };
        const current = await body(profile);
        if (!current) return { kind: 'unavailable' };
        const desired = ownerFirstName(principal.verifiedEmail);
        if (current.displayname !== desired) {
          const written = await request(path, { method: 'PUT', headers, body: JSON.stringify({ displayname: desired }) }, call);
          if (written.status !== 200) return { kind: 'unavailable' };
        }
      } catch { return { kind: 'unavailable' }; }
      return {
        kind: 'ok',
        session: {
          homeserverOrigin,
          ...session,
          publishedFingerprint: await publishedFingerprint(session, call),
        },
      };
    },
    async resolveParticipants(userIds, call) {
      if (userIds.length > 100 || new Set(userIds).size !== userIds.length) return { kind: 'unavailable' };
      const participants: MatrixParticipant[] = [];
      for (const userId of userIds) {
        const human = participantFor(userId);
        if (!human) return { kind: 'unavailable' };
        let name: unknown;
        try {
          const profile = await request(`/_matrix/client/v3/profile/${encodeURIComponent(userId)}/displayname`, {}, call);
          if (profile.status === 200) name = (await body(profile))?.displayname;
        } catch { /* Missing profiles use the Matrix user id. */ }
        participants.push({ ...human, displayName: displayName(name, userId) });
      }
      return { kind: 'ok', participants };
    },
    async resolveRoomParticipants(ownerId, roomId, userIds, call, targetParticipantIds = [], browserSession) {
      if (userIds.length > 100 || new Set(userIds).size !== userIds.length) return { kind: 'unavailable' };
      if (browserSession && browserSession.matrixUserId !== accountId(ownerId)) return { kind: 'forbidden' };
      const localDiagnostic: LocalParticipantDiagnostic = { stage: 'membership', status: 0 };
      const membership = await membershipForOwner(ownerId, roomId, call, localDiagnostic, browserSession?.accessToken);
      if (membership.kind === 'absent') return { kind: 'forbidden' };
      if (membership.kind !== 'joined') return { kind: 'unavailable', localDiagnostic };
      const accessToken = browserSession?.accessToken ?? (await controlLogin(ownerId, call, localDiagnostic))?.accessToken;
      if (!accessToken) return { kind: 'unavailable', localDiagnostic };
      const response = await request(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`,
        { headers: { authorization: `Bearer ${accessToken}` } }, call);
      localDiagnostic.stage = 'joined_members';
      localDiagnostic.status = response.status;
      const joined = response.status === 200 ? safeObject((await body(response))?.joined) : null;
      if (!joined || Object.keys(joined).length > 100)
        return { kind: 'unavailable', localDiagnostic };
      // Owner-map agents are not indexed by participant id.
      void targetParticipantIds;
      const participants: Participant[] = [];
      for (const userId of userIds) {
        const name = displayName(safeObject(joined[userId])?.display_name, userId);
        const human = participantFor(userId);
        if (human) { participants.push({ ...human, displayName: name }); continue; }
        const agent = await readAgentOwner(userId, call);
        participants.push(agent ? { matrixUserId: userId, participantId: agentParticipantId(userId),
          ownerId: agent.ownerId, displayName: name, kind: 'agent', ownerLabel: agent.ownerLabel, harness: agent.harness }
          : { matrixUserId: userId, displayName: name, kind: 'unknown' });
      }
      return { kind: 'ok', participants };
    },
  };

  const controlDevice = (ownerId: OwnerId) => `KHALA_CONTROL_${createHash('sha256').update(ownerId).digest('hex').slice(0, 24)}` as DeviceId;
  async function controlLogin(ownerId: OwnerId, call?: CallOptions, diagnostic?: LocalParticipantDiagnostic): Promise<MatrixLogin | null> {
    if (call?.signal?.aborted) return null;
    const cached = controlSessions.get(ownerId);
    if (cached && cached.expiresAt > Date.now()) return cached.session;
    controlSessions.delete(ownerId);
    if (Date.now() < (controlRetryAfter.get(ownerId) ?? 0)) {
      if (diagnostic) { diagnostic.stage = 'control_login'; diagnostic.status = 0; }
      return null;
    }
    let pending = controlLogins.get(ownerId);
    if (!pending) {
      pending = login(ownerId, controlDevice(ownerId), undefined, diagnostic);
      controlLogins.set(ownerId, pending);
      void pending.then(session => {
        if (session) {
          controlRetryAfter.delete(ownerId);
          // Keep one bounded control token per owner in this warm function. All
          // callers still pass through their own human/agent authorization.
          if (controlSessions.size >= 128) controlSessions.delete(controlSessions.keys().next().value!);
          controlSessions.set(ownerId, { session, expiresAt: Date.now() + 10 * 60_000 });
        } else {
          for (const [key, until] of controlRetryAfter) if (until <= Date.now()) controlRetryAfter.delete(key);
          if (controlRetryAfter.size >= 128) controlRetryAfter.delete(controlRetryAfter.keys().next().value!);
          // Matrix's 429 already provides a retry interval. A fixed minute
          // here suppresses recovery even after Synapse permits the login.
          const loginKey = `${ownerId}\0${controlDevice(ownerId)}`;
          const matrixRetryAfter = loginRetryAfter.get(loginKey);
          controlRetryAfter.set(ownerId, matrixRetryAfter && matrixRetryAfter > Date.now()
            ? matrixRetryAfter : Date.now() + 60_000);
        }
      }).finally(() => { if (controlLogins.get(ownerId) === pending) controlLogins.delete(ownerId); });
    }
    const session = await pending;
    return call?.signal?.aborted ? null : session;
  }
  async function authenticated(principal: AuthPrincipal, call?: CallOptions): Promise<MatrixLogin | null> {
    return controlLogin(principal.ownerId, call);
  }

  async function roomName(session: MatrixLogin, roomId: RoomId, call?: CallOptions): Promise<string | null> {
    try {
      const response = await request(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name/`, {
        headers: { authorization: `Bearer ${session.accessToken}` },
      }, call);
      if (response.status !== 200) return null;
      const value = await body(response);
      return typeof value?.name === 'string' ? value.name : null;
    } catch {
      return null;
    }
  }

  async function membershipForOwner(ownerId: OwnerId, roomId: RoomId, call?: CallOptions, diagnostic?: LocalParticipantDiagnostic, browserAccessToken?: string): Promise<GatewayInspection> {
    const accessToken = browserAccessToken ?? (await controlLogin(ownerId, call, diagnostic))?.accessToken;
    if (!accessToken) return { kind: 'unavailable' };
    try {
      const response = await request(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(accountId(ownerId))}`,
        { headers: { authorization: `Bearer ${accessToken}` } },
        call,
      );
      if (diagnostic) { diagnostic.stage = 'membership'; diagnostic.status = response.status; }
      if (response.status === 404 || response.status === 403) return { kind: 'absent' };
      const value = await body(response);
      return response.status === 200 && value?.membership === 'join'
        ? { kind: 'joined', historyReady: true }
        : { kind: 'unavailable' };
    } catch {
      return { kind: 'unavailable' };
    }
  }

  async function inspectRoomSenderDevices(ownerId: OwnerId, roomId: RoomId, call?: CallOptions): Promise<
    Readonly<{ kind: 'ok'; senders: readonly MatrixRoomSenderDevice[] }> | Readonly<{ kind: 'unavailable' }>
  > {
    const unavailable = { kind: 'unavailable' } as const;
    const session = await controlLogin(ownerId, call);
    if (!session) return unavailable;
    const headers = { authorization: `Bearer ${session.accessToken}` };
    async function joinedUsers(): Promise<readonly string[] | null> {
      const response = await request(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`, { headers }, call);
      if (response.status !== 200) return null;
      const joined = safeObject((await body(response))?.joined);
      if (!joined || !Object.hasOwn(joined, session!.userId) || Object.keys(joined).length > 100
        || Object.values(joined).some(member => !safeObject(member))) return null;
      return Object.keys(joined).sort();
    }
    try {
      const users = await joinedUsers();
      if (!users) return unavailable;
      const index = createOwnerRoomIndex(options.store);
      const bindings = createAgentBindingStore({ store: options.store });
      const humans = users.map(participantFor).filter((item) => item !== null);
      const expected = new Map<string, Set<string> | null>(humans.map(human => [human.matrixUserId, null]));
      const knownAgents = new Set<string>();
      const snapshots: { ownerId: OwnerId; value: string }[] = [];
      for (const human of humans) {
        const indexed = await index.inspect(human.ownerId, roomId);
        if (indexed.kind !== 'ok') return unavailable;
        snapshots.push({ ownerId: human.ownerId, value: JSON.stringify(indexed.value) });
        for (const item of indexed.value?.bindings ?? []) {
          const found = await bindings.locateBinding(item.bindingId);
          if (found.kind !== 'found' || found.address.roomId !== roomId
            || found.record.binding.ownerId !== human.ownerId || found.record.binding.generation !== item.generation) return unavailable;
          const binding = found.record.binding;
          const identity = agentMatrixIdentity(human.ownerId, binding, serverName);
          if (identity.participantId !== binding.agentParticipantId) return unavailable;
          knownAgents.add(identity.userId);
          if (found.record.revokedGeneration !== null) continue;
          if (!users.includes(identity.userId)) return unavailable;
          const devices = expected.get(identity.userId) ?? new Set<string>();
          devices.add(binding.deviceId); expected.set(identity.userId, devices);
        }
      }
      // Unknown local managed identities may be legacy senders. External Matrix
      // clients are outside this adapter's inventory, but never skip its own users.
      if (users.some(user => user.startsWith('@khala_') && user.endsWith(`:${serverName}`)
        && !expected.has(user) && !knownAgents.has(user))) return unavailable;
      const response = await request('/_matrix/client/v3/keys/query', {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ device_keys: Object.fromEntries([...expected.keys()].map(user => [user, []])) }),
      }, call);
      if (response.status !== 200) return unavailable;
      const value = await body(response);
      const failures = value?.failures === undefined ? {} : safeObject(value.failures);
      const deviceKeys = safeObject(value?.device_keys);
      if (!failures || Object.keys(failures).length || !deviceKeys
        || Object.keys(deviceKeys).length !== expected.size) return unavailable;
      const senders: MatrixRoomSenderDevice[] = [];
      for (const [userId, required] of expected) {
        const devices = safeObject(deviceKeys[userId]);
        if (!devices || Object.keys(devices).length > 128) return unavailable;
        for (const needed of required ?? []) if (!Object.hasOwn(devices, needed)) return unavailable;
        for (const [deviceId, raw] of Object.entries(devices)) {
          const device = safeObject(raw);
          if (!device || device.user_id !== userId || device.device_id !== deviceId
            || !deviceId || deviceId.length > 255) return unavailable;
          const keys = safeObject(device.keys);
          const curve = keys?.[`curve25519:${deviceId}`];
          if (deviceId.startsWith('KHALA_CONTROL_') && (!keys || Object.keys(keys).length === 0)) continue;
          if (required && !required.has(deviceId)) return unavailable;
          if (typeof curve !== 'string' || !/^[A-Za-z0-9+/]{43}$/u.test(curve)
            || Buffer.from(curve, 'base64').length !== 32
            || Buffer.from(curve, 'base64').toString('base64').replace(/=+$/u, '') !== curve) return unavailable;
          senders.push({ matrixUserId: userId, deviceId, curve25519: curve });
          if (senders.length > 512) return unavailable;
        }
      }
      if (JSON.stringify(await joinedUsers()) !== JSON.stringify(users)) return unavailable;
      for (const snapshot of snapshots) {
        const current = await index.inspect(snapshot.ownerId, roomId);
        if (current.kind !== 'ok' || JSON.stringify(current.value) !== snapshot.value) return unavailable;
      }
      return { kind: 'ok', senders };
    } catch { return unavailable; }
  }

  const membership = (principal: AuthPrincipal, roomId: RoomId, call?: CallOptions) =>
    membershipForOwner(principal.ownerId, roomId, call);

  const authority: InvitationAuthority = {
    async canShare({ principal, roomId }, call) {
      const result = await membership(principal, roomId, call);
      if (result.kind === 'joined') {
        return await rememberAuthority(roomId, principal.ownerId, call) ? 'allowed' : 'unavailable';
      }
      return result.kind === 'absent' ? 'forbidden' : 'unavailable';
    },
  };

  async function lookup(input: GatewayRequest, call?: CallOptions): Promise<GatewayLookup> {
    const result = await membership(input.principal, input.roomId, call);
    if (result.kind !== 'joined') return result;
    const session = await authenticated(input.principal, call);
    if (session === null) return { kind: 'unavailable' };
    return {
      kind: 'joined',
      room: matrixRoom(input.roomId, await roomName(session, input.roomId, call)),
      historyReady: true,
    };
  }

  const gateway: AdmissionGateway = {
    inspectMembership: (input, call) => membership(input.principal, input.roomId, call),
    lookup,
    async admit(input, call): Promise<GatewayAdmission> {
      const current = await lookup(input, call);
      if (current.kind === 'joined') return current;
      if (current.kind === 'unavailable' || current.kind === 'outcome_unknown') return current;
      const creatorOwnerId = await roomAuthority(input.roomId, call);
      if (creatorOwnerId === null) return { kind: 'unavailable' };
      const creatorSession = await controlLogin(creatorOwnerId, call);
      const session = await authenticated(input.principal, call);
      if (creatorSession === null || session === null) return { kind: 'unavailable' };
      try {
        const invitation = await request(`/_matrix/client/v3/rooms/${encodeURIComponent(input.roomId)}/invite`, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${creatorSession.accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ user_id: session.userId }),
        }, call);
        if (invitation.status === 403) return { kind: 'forbidden' };
        if (invitation.status >= 500) return { kind: 'outcome_unknown' };
        if (![200, 409].includes(invitation.status)) return { kind: 'unavailable' };
        const response = await request(`/_matrix/client/v3/join/${encodeURIComponent(input.roomId)}`, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${session.accessToken}`,
            'content-type': 'application/json',
          },
          body: '{}',
        }, call);
        const value = await body(response);
        if (response.status === 403) return { kind: 'forbidden' };
        if (response.status >= 500) return { kind: 'outcome_unknown' };
        if (response.status !== 200 || value?.room_id !== input.roomId) return { kind: 'unavailable' };
        return {
          kind: 'joined',
          room: matrixRoom(input.roomId, await roomName(session, input.roomId, call)),
          historyReady: true,
        };
      } catch {
        return { kind: 'outcome_unknown' };
      }
    },
  };

  function channelCreateFor(ownerId: OwnerId): ChannelCreateSubstrate {
    return {
      async createRoom(input, call) {
        const session = await controlLogin(ownerId, call);
        if (!session) return { kind: 'unavailable' };
        try {
          const response = await request('/_matrix/client/v3/createRoom', {
            method: 'POST', headers: { authorization: `Bearer ${session.accessToken}`,
              'content-type': 'application/json' },
            body: JSON.stringify({ visibility: 'private', preset: 'private_chat',
              ...(input.title ? { name: input.title } : {}),
              initial_state: [
                { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
                { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'shared' } },
                { type: 'com.aiur.khala.create.v1', state_key: '', content: { operation_id: input.operationId } },
              ] }),
          }, call);
          const value = await body(response);
          if (response.status === 403) return { kind: 'rejected', code: 'forbidden' };
          if (response.status >= 500) return { kind: 'unknown' };
          const room = decodeRoomId(value?.room_id);
          if (response.status !== 200 || !room.ok) return { kind: 'unavailable' };
          if (!await rememberAuthority(room.value, ownerId, call)
            || await roomAuthority(room.value, call) !== ownerId) return { kind: 'unknown' };
          return { kind: 'done', value: matrixRoom(room.value, input.title) };
        } catch { return { kind: 'unknown' }; }
      },
      async findCreatedRoom(input, call) {
        const session = await controlLogin(ownerId, call);
        if (!session) return { kind: 'unavailable' };
        try {
          const response = await request('/_matrix/client/v3/joined_rooms', {
            headers: { authorization: `Bearer ${session.accessToken}` },
          }, call);
          const value = await body(response);
          if (response.status !== 200 || !Array.isArray(value?.joined_rooms)
            || value.joined_rooms.length > 1000) return { kind: 'unavailable' };
          for (const raw of value.joined_rooms) {
            const room = decodeRoomId(raw);
            if (!room.ok) return { kind: 'unavailable' };
            const marker = await request(`/_matrix/client/v3/rooms/${encodeURIComponent(room.value)}/state/com.aiur.khala.create.v1/`, {
              headers: { authorization: `Bearer ${session.accessToken}` },
            }, call);
            if (marker.status === 404) continue;
            if (marker.status !== 200) return { kind: 'unavailable' };
            const detail = await body(marker);
            if (detail?.operation_id !== input.operationId) continue;
            if (!await rememberAuthority(room.value, ownerId, call)
              || await roomAuthority(room.value, call) !== ownerId) return { kind: 'unavailable' };
            return { kind: 'found', room: matrixRoom(room.value, null) };
          }
          // A missing marker in a joined-room snapshot cannot prove that a
          // timed-out create did not land; never allocate a second room.
          return { kind: 'unknown' };
        } catch { return { kind: 'unavailable' }; }
      },
    };
  }

  return { directory, sessions, authority, gateway, inspectOwnerMembership: membershipForOwner,
    inspectOwnerDeviceKey,
    inspectRoomAuthority: roomAuthority, inspectRoomSenderDevices, channelCreateFor };
}
