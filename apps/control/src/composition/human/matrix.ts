import { createHash, createHmac } from 'node:crypto';
import type {
  AuthPrincipal,
  CallOptions,
  DeviceId,
  OwnerId,
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
  serverName: string;
  registrationSharedSecret: string;
  passwordDerivationSecret: string;
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
}

export type MatrixHumanServices = Readonly<{
  directory: MessagingAccountDirectory;
  sessions: MatrixSessionIssuer;
  authority: InvitationAuthority;
  gateway: AdmissionGateway;
}>;

type MatrixLogin = Readonly<{ userId: string; accessToken: string; deviceId: DeviceId }>;

function exactHttpsOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.origin !== value
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

function localpart(ownerId: OwnerId): string {
  return `khala_${createHash('sha256').update(ownerId).digest('hex').slice(0, 40)}`;
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
  const homeserverOrigin = exactHttpsOrigin(options.homeserverOrigin);
  const serverName = validateServerName(options.serverName);
  const registrationSecret = requireSecret(options.registrationSharedSecret, 'Matrix registration shared secret');
  const passwordSecret = requireSecret(options.passwordDerivationSecret, 'Matrix password derivation secret');
  const fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 10_000;

  const accountId = (ownerId: OwnerId) => `@${localpart(ownerId)}:${serverName}`;
  const password = (ownerId: OwnerId) => createHmac('sha256', passwordSecret)
    .update('khala-matrix-password-v1\0')
    .update(ownerId)
    .digest('base64url');

  async function request(path: string, init: RequestInit = {}, call?: CallOptions): Promise<Response> {
    const signal = AbortSignal.any([
      AbortSignal.timeout(timeoutMs),
      ...(call?.signal ? [call.signal] : []),
    ]);
    return fetch(`${homeserverOrigin}${path}`, { ...init, signal });
  }

  async function exists(ownerId: OwnerId, call?: CallOptions): Promise<'found' | 'absent' | 'unavailable'> {
    try {
      const response = await request(`/_matrix/client/v3/profile/${encodeURIComponent(accountId(ownerId))}`, {}, call);
      if (response.status === 200) return 'found';
      const value = await body(response);
      return response.status === 404 && value?.errcode === 'M_NOT_FOUND' ? 'absent' : 'unavailable';
    } catch {
      return 'unavailable';
    }
  }

  async function register(ownerId: OwnerId, call?: CallOptions): Promise<'created' | 'unavailable' | 'outcome_unknown'> {
    try {
      const nonceResponse = await request('/_synapse/admin/v1/register', { headers: { accept: 'application/json' } }, call);
      const nonceBody = await body(nonceResponse);
      if (nonceResponse.status !== 200 || typeof nonceBody?.nonce !== 'string') return 'unavailable';
      const username = localpart(ownerId);
      const adminFlag = 'notadmin';
      const mac = createHmac('sha1', registrationSecret)
        .update(nonceBody.nonce).update('\0')
        .update(username).update('\0')
        .update(password(ownerId)).update('\0')
        .update(adminFlag)
        .digest('hex');
      const response = await request('/_synapse/admin/v1/register', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
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
      if (response.status !== 200) return null;
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
  };

  const controlDevice = (ownerId: OwnerId) => `KHALA_CONTROL_${createHash('sha256').update(ownerId).digest('hex').slice(0, 24)}` as DeviceId;
  async function authenticated(principal: AuthPrincipal, call?: CallOptions): Promise<MatrixLogin | null> {
    return login(principal.ownerId, controlDevice(principal.ownerId), call);
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

  async function membership(principal: AuthPrincipal, roomId: RoomId, call?: CallOptions): Promise<GatewayInspection> {
    const session = await authenticated(principal, call);
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

  const authority: InvitationAuthority = {
    async canShare({ principal, roomId }, call) {
      const result = await membership(principal, roomId, call);
      if (result.kind === 'joined') return 'allowed';
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
      const current = await lookup(input, call);
      if (current.kind === 'joined') return current;
      if (current.kind === 'unavailable' || current.kind === 'outcome_unknown') return current;
      const session = await authenticated(input.principal, call);
      if (session === null) return { kind: 'unavailable' };
      try {
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

  return { directory, sessions, authority, gateway };
}
