import { decodeHumanInitialsRecord, humanInitialsRecordKey } from '@khala/contracts/m1/initials';
import { createHash, createHmac } from 'node:crypto';
import {
  agentOwnerRecordKey, decodeAgentOwnerRecord, humanEmailRecordKey, ownerFirstName, readParticipantEmail,
  type AgentOwnerRecord, type HumanEmailRecord, type Participant,
} from '@khala/contracts/m1/participants';
import { decodeProfileRecord, profileRecordKey } from '@khala/contracts/m1/profile';
import { decodeHumanColorRecord, defaultHumanColor, humanColorRecordKey, type HumanColorId } from '@khala/contracts/m1/colors';
import { decodeOwnerId } from '@khala/contracts/messaging/index';
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
  roomName(ownerId: OwnerId, roomId: RoomId): Promise<string | null>;
  setOwnerDisplayName(ownerId: OwnerId, name: string): Promise<boolean>;

}>;


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
  async function readHumanEmail(ownerId: OwnerId, call?: CallOptions): Promise<string | null> {
    try {
      const read = await options.store.read<HumanEmailRecord>(humanEmailRecordKey(ownerId), call);
      if (read.kind !== 'record') return null;
      const value = safeObject(read.record.value);
      return value?.v === 1 && value.ownerId === ownerId ? readParticipantEmail(value.email, 'email') : null;
    } catch { return null; }
  }
  async function readHumanInitials(ownerId: string, call?: CallOptions): Promise<string | null> {
    try {
      const read = await options.store.read(humanInitialsRecordKey(ownerId), call);
      const decoded = read.kind === 'record' ? decodeHumanInitialsRecord(read.record.value) : null;
      if (decoded?.ok && decoded.value.ownerId === ownerId) return decoded.value.initials;
    } catch { /* Initials are optional display data. */ }
    return null;
  }
  async function readHumanColor(ownerId: string, call?: CallOptions): Promise<HumanColorId> {
    try {
      const read = await options.store.read(humanColorRecordKey(ownerId), call);
      const decoded = read.kind === 'record' ? decodeHumanColorRecord(read.record.value) : null;
      if (decoded?.ok && decoded.value.ownerId === ownerId) return decoded.value.color;
    } catch { /* Colours are best effort display data. */ }
    return defaultHumanColor(ownerId);
  }
  /** Best effort: records the owner's current verified email so channel members can see it. */
  async function rememberHumanEmail(ownerId: OwnerId, email: string, call?: CallOptions): Promise<void> {
    try {
      const key = humanEmailRecordKey(ownerId);
      const current = await options.store.read<HumanEmailRecord>(key, call);
      if (current.kind === 'unavailable') return;
      if (current.kind === 'record' && current.record.value.email === email && current.record.value.ownerId === ownerId) return;
      const value: HumanEmailRecord = { v: 1, ownerId, email };
      const expectedRevision = current.kind === 'record' ? current.record.revision : null;
      await options.store.compareAndSet({
        key, expectedRevision,
        operationId: `humans.email.${createHash('sha256').update(JSON.stringify([ownerId, email, expectedRevision])).digest('hex')}`,
        next: { value, expiresAt: null },
      }, call);
    } catch { /* Emails are display data; a failed write never prevents session minting. */ }
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

  async function setDisplayName(session: MatrixLogin, name: string, call?: CallOptions): Promise<boolean> {
    try {
      const path = `/_matrix/client/v3/profile/${encodeURIComponent(session.userId)}/displayname`;
      const headers = { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json' };
      const profile = await request(path, { headers }, call);
      if (profile.status === 200 && (await body(profile))?.displayname === name) return true;
      if (profile.status !== 200 && profile.status !== 404) return false;
      const written = await request(path, { method: 'PUT', headers, body: JSON.stringify({ displayname: name }) }, call);
      return written.ok;
    } catch { return false; }
  }

  const sessions: MatrixSessionIssuer = {
    async issue(principal, deviceId, call) {
      const session = await login(principal.ownerId, deviceId, call);
      if (session === null) return { kind: 'unavailable' };
      try {
        const stored = await options.store.read(profileRecordKey(principal.ownerId), call);
        if (stored.kind === 'record' || stored.kind === 'absent') {
          const decoded = stored.kind === 'record' ? decodeProfileRecord(stored.record.value) : null;
          const desired = decoded?.ok && decoded.value.ownerId === principal.ownerId
            ? decoded.value.username : ownerFirstName(principal.verifiedEmail);
          await setDisplayName(session, desired, call);
        }
      } catch { /* Profile labels are best effort and never prevent session minting. */ }
      await rememberHumanEmail(principal.ownerId, principal.verifiedEmail, call);
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
      const participants = userIds.map(userId => participantFor(userId)
        ?? { matrixUserId: userId, displayName: userId, kind: 'unknown' as const });
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
      const ownerUsernames = new Map<string, string | null>();
      const ownerInitials = new Map<string, string | null>();
      const initialsOf = async (ownerId: string): Promise<string | null> => {
        if (!ownerInitials.has(ownerId)) ownerInitials.set(ownerId, await readHumanInitials(ownerId, call));
        return ownerInitials.get(ownerId)!;
      };
      const ownerColors = new Map<string, HumanColorId>();
      const colorOf = async (ownerId: string): Promise<HumanColorId> => {
        if (!ownerColors.has(ownerId)) ownerColors.set(ownerId, await readHumanColor(ownerId, call));
        return ownerColors.get(ownerId)!;
      };
      for (const userId of userIds) {
        const name = displayName(safeObject(joined[userId])?.display_name, userId);
        const human = participantFor(userId);
        if (human) {
          // Members of the same channel may see each other's verified email (membership checked above).
          const email = await readHumanEmail(human.ownerId, call);
          const initials = await initialsOf(human.ownerId);
          participants.push({ ...human, ...(initials ? { initials } : {}), displayName: name, color: await colorOf(human.ownerId), ...(email ? { email } : {}) });
          continue;
        }
        const agent = await readAgentOwner(userId, call);
        if (agent && !ownerUsernames.has(agent.ownerId)) {
          let username: string | null = null;
          try {
            const read = await options.store.read(profileRecordKey(agent.ownerId), call);
            const decoded = read.kind === 'record' ? decodeProfileRecord(read.record.value) : null;
            if (decoded?.ok && decoded.value.ownerId === agent.ownerId) username = decoded.value.username;
          } catch { /* Keep the stored owner label if the current profile cannot be read. */ }
          ownerUsernames.set(agent.ownerId, username);
        }
        const initials = agent ? await initialsOf(agent.ownerId) : null;
        participants.push(agent ? { matrixUserId: userId, participantId: agentParticipantId(userId),
          ownerId: agent.ownerId, displayName: name, kind: 'agent', ownerLabel: ownerUsernames.get(agent.ownerId) ?? agent.ownerLabel,
          harness: agent.harness, ...(initials ? { ownerInitials: initials } : {}), ownerColor: await colorOf(agent.ownerId) }
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

  return { directory, sessions, authority, gateway, inspectOwnerMembership: membershipForOwner,
    setOwnerDisplayName: async (ownerId, name) => {
      try {
        const session = await controlLogin(ownerId);
        return session ? await setDisplayName(session, name) : false;
      } catch { return false; }
    },
    roomName: async (ownerId, roomId) => {
      const session = await controlLogin(ownerId);
      return session ? (await roomName(session, roomId)) || null : null;
    },
  };
}
