import { createHash, createHmac } from 'node:crypto';
import { createAgentBindingStore } from '../../agent-bootstrap/store';
import { createOwnerRoomIndex } from '../../agent-bootstrap/owner-room-index';
import { agentMatrixIdentity } from '../agent/matrix-admission';
import { createAgentIdentityDirectory } from '../agent/identity-directory';
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

export interface MatrixSessionIssuer {
  issue(principal: AuthPrincipal, deviceId: DeviceId, options?: CallOptions): Promise<
    Readonly<{ kind: 'ok'; session: MatrixBrowserSession }>
    | Readonly<{ kind: 'unavailable' }>
  >;
  resolveParticipants(userIds: readonly string[], options?: CallOptions): Promise<
    Readonly<{ kind: 'ok'; participants: readonly MatrixParticipant[] }>
    | Readonly<{ kind: 'unavailable' }>
  >;
  resolveRoomParticipants(ownerId: OwnerId, roomId: RoomId, userIds: readonly string[], options?: CallOptions): Promise<
    Readonly<{ kind: 'ok'; participants: readonly MatrixParticipant[] }>
    | Readonly<{ kind: 'forbidden' | 'unavailable' }>
  >;
}

export type MatrixParticipant = Readonly<{
  matrixUserId: string;
  participantId: ParticipantId;
  ownerId: OwnerId;
  displayName: string;
  kind?: 'human' | 'agent';
}>;

export type MatrixHumanServices = Readonly<{
  directory: MessagingAccountDirectory;
  sessions: MatrixSessionIssuer;
  authority: InvitationAuthority;
  gateway: AdmissionGateway;
  /** Recheck a bound owner's live Matrix membership without accepting a caller-supplied principal. */
  inspectOwnerMembership(ownerId: OwnerId, roomId: RoomId): Promise<GatewayInspection>;
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
  const participantFor = (userId: string): MatrixParticipant | null => {
    const ownerId = ownerFromMatrixUserId(userId, serverName);
    if (!ownerId) return null;
    return {
      matrixUserId: userId,
      participantId: `human_${createHash('sha256').update(userId).digest('hex').slice(0, 40)}` as ParticipantId,
      ownerId,
      displayName: userId,
    };
  };
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

  async function login(ownerId: OwnerId, deviceId: DeviceId, call?: CallOptions): Promise<MatrixLogin | null> {
    const loginKey = `${ownerId}\0${deviceId}`;
    if (Date.now() < (loginRetryAfter.get(loginKey) ?? 0)) return null;
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
      return {
        kind: 'ok',
        session: {
          homeserverOrigin,
          ...session,
          publishedFingerprint: await publishedFingerprint(session, call),
        },
      };
    },
    async resolveParticipants(userIds) {
      if (userIds.length > 100 || new Set(userIds).size !== userIds.length) return { kind: 'unavailable' };
      const participants = userIds.map(participantFor);
      return participants.every((participant): participant is MatrixParticipant => participant !== null)
        ? { kind: 'ok', participants }
        : { kind: 'unavailable' };
    },
    async resolveRoomParticipants(ownerId, roomId, userIds, call) {
      if (userIds.length > 100 || new Set(userIds).size !== userIds.length) return { kind: 'unavailable' };
      const membership = await membershipForOwner(ownerId, roomId, call);
      if (membership.kind === 'absent') return { kind: 'forbidden' };
      if (membership.kind !== 'joined') return { kind: 'unavailable' };
      const session = await controlLogin(ownerId, call);
      if (!session) return { kind: 'unavailable' };
      const response = await request(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`,
        { headers: { authorization: `Bearer ${session.accessToken}` } }, call);
      const joined = response.status === 200 ? safeObject((await body(response))?.joined) : null;
      if (!joined || Object.keys(joined).length > 100)
        return { kind: 'unavailable' };
      const resolved = new Map<string, MatrixParticipant>();
      const identities = createAgentIdentityDirectory(options.store);
      const index = createOwnerRoomIndex(options.store);
      const bindings = createAgentBindingStore({ store: options.store });
      for (const userId of userIds) {
        const human = participantFor(userId);
        if (human) { resolved.set(userId, human); continue; }
        let agent = await identities.lookup(roomId, userId);
        if (!agent && Object.hasOwn(joined, userId)) {
          // Backfill agents admitted before the identity directory existed.
          for (const joinedUserId of Object.keys(joined)) {
            const owner = participantFor(joinedUserId);
            if (!owner) continue;
            const indexed = await index.inspect(owner.ownerId, roomId);
            if (indexed.kind !== 'ok') return { kind: 'unavailable' };
            for (const item of indexed.value?.bindings ?? []) {
              const found = await bindings.locateBinding(item.bindingId);
              if (found.kind !== 'found' || found.address.roomId !== roomId
                || found.record.binding.ownerId !== owner.ownerId || found.record.binding.generation !== item.generation)
                return { kind: 'unavailable' };
              const identity = agentMatrixIdentity(owner.ownerId, found.record.binding, serverName);
              if (identity.userId !== userId || identity.participantId !== found.record.binding.agentParticipantId) continue;
              const candidate = { v: 1 as const, roomId, matrixUserId: userId,
                participantId: identity.participantId, ownerId: owner.ownerId, harness: found.record.binding.harness };
              if (!await identities.remember(candidate)) return { kind: 'unavailable' };
              agent = candidate;
              break;
            }
            if (agent) break;
          }
        }
        if (!agent) return { kind: 'unavailable' };
        resolved.set(userId, { matrixUserId: userId, participantId: agent.participantId,
          ownerId: agent.ownerId, displayName: `${agent.harness[0]?.toUpperCase()}${agent.harness.slice(1)} #${agent.participantId.slice(-4)}`,
          kind: 'agent' });
      }
      return userIds.every(userId => resolved.has(userId))
        ? { kind: 'ok', participants: userIds.map(userId => resolved.get(userId)!) }
        : { kind: 'unavailable' };
    },
  };

  const controlDevice = (ownerId: OwnerId) => `KHALA_CONTROL_${createHash('sha256').update(ownerId).digest('hex').slice(0, 24)}` as DeviceId;
  async function controlLogin(ownerId: OwnerId, call?: CallOptions): Promise<MatrixLogin | null> {
    if (call?.signal?.aborted) return null;
    const cached = controlSessions.get(ownerId);
    if (cached && cached.expiresAt > Date.now()) return cached.session;
    controlSessions.delete(ownerId);
    if (Date.now() < (controlRetryAfter.get(ownerId) ?? 0)) return null;
    let pending = controlLogins.get(ownerId);
    if (!pending) {
      pending = login(ownerId, controlDevice(ownerId));
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
          controlRetryAfter.set(ownerId, Date.now() + 60_000);
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

  async function membershipForOwner(ownerId: OwnerId, roomId: RoomId, call?: CallOptions): Promise<GatewayInspection> {
    const session = await controlLogin(ownerId, call);
    if (session === null) return { kind: 'unavailable' };
    try {
      const response = await request(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(session.userId)}`,
        { headers: { authorization: `Bearer ${session.accessToken}` } },
        call,
      );
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
      const humans = users.map(participantFor).filter((item): item is MatrixParticipant => item !== null);
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
      // The production default is no-history. Full-history remains fail-closed
      // until the crypto adapter proves the requested historical keys arrived.
      historyReady: input.history === 'none',
    };
  }

  const gateway: AdmissionGateway = {
    inspectMembership: (input, call) => membership(input.principal, input.roomId, call),
    lookup,
    async admit(input, call): Promise<GatewayAdmission> {
      // Full-history disclosure requires an explicit crypto key-transfer proof.
      // The selected production adapter does not have that proof yet, so reject
      // the policy before changing membership instead of leaving it ambiguous.
      if (input.history === 'full') return { kind: 'forbidden' };
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
          historyReady: input.history === 'none',
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
                { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'joined' } },
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
    inspectRoomAuthority: roomAuthority, inspectRoomSenderDevices, channelCreateFor };
}
