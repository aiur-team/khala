import { createHash, createHmac } from 'node:crypto';
import type { ControlStore, OwnerId, ParticipantId, RoomId, SessionBinding } from '@khala/contracts/messaging/index';
import {
  PAIRING_INVITE_PREFIX,
  type AgentAdmissionPort,
  type AgentDeviceSessionPort,
  type InviteEvidence,
  type SessionRef,
} from '../../agent-bootstrap/handler';
import { matchesInviteEvidence } from './invite-evidence';
import { ownerMatrixUserId } from '../human/matrix-identity';

type Fetch = typeof globalThis.fetch;

export type MatrixAgentAdmissionOptions = Readonly<{
  homeserverOrigin: string;
  allowInsecureLoopback?: boolean;
  serverName: string;
  registrationSharedSecret: string;
  passwordDerivationSecret: string;
  invitationHmacSecret: string;
  /** Preview ingress protects only Synapse shared-secret registration GET/POST. */
  registrationIngressToken?: string;
  store: ControlStore;
  clock: () => number;
  fetch?: Fetch;
}>;

export type MatrixAgentAdmission = Readonly<{
  agents: AgentAdmissionPort;
  deviceSession: AgentDeviceSessionPort;
  inspectAgentRoomMembership(ownerId: OwnerId, session: SessionRef, roomId: RoomId): Promise<'joined' | 'absent' | 'unavailable'>;
  publishedDeviceFingerprint(binding: SessionBinding): Promise<string | null>;
  publishedDeviceIdentityKey(binding: SessionBinding): Promise<string | null>;
  inspectPublishedDevice(binding: SessionBinding, expectedCurve25519: string): Promise<MatrixDeviceStatus>;
  /** Caller owns authorization, endpoint quiescence and admission/send fencing. */
  removePublishedDeviceWithUIA(binding: SessionBinding, expectedCurve25519: string): Promise<MatrixDeviceRemoval>;
}>;

export type MatrixDeviceStatus = 'removed' | 'present' | 'replaced' | 'unavailable';

export type MatrixDeviceRemoval = 'removed' | 'replaced' | 'reauthentication_required'
  | 'forbidden' | 'unavailable' | 'outcome_unknown';

function textObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function digest(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

/** One Matrix account belongs to one signed-in owner's exact existing session. */
export function agentMatrixIdentity(ownerId: OwnerId, session: SessionRef, serverName: string) {
  const mark = digest(ownerId, session.harness, session.sessionId);
  const username = `khala_a_${mark.slice(0, 32)}`;
  const userId = `@${username}:${serverName}`;
  const participantId = `agent_${digest(userId).slice(0, 40)}` as ParticipantId;
  return { username, userId, participantId };
}

/**
 * Hosted Matrix admission uses the already-approved owner browser grant, then
 * the configured Synapse shared-secret registration endpoint. Control may hold
 * a transient login token for the join operation; it never creates or holds the
 * connector's E2EE keys. The connector receives its own device token only after
 * the one-use DPoP grant has bound the exact owner/session/device.
 */
export function createMatrixAgentAdmission(options: MatrixAgentAdmissionOptions): MatrixAgentAdmission {
  const origin = new URL(options.homeserverOrigin);
  const loopback = options.allowInsecureLoopback === true && origin.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (!(origin.protocol === 'https:' || loopback) || origin.origin !== options.homeserverOrigin) throw new Error('Matrix origin must be exact HTTPS');
  if (!/^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/u.test(options.serverName)) throw new Error('invalid Matrix server name');
  if (Buffer.byteLength(options.registrationSharedSecret) < 32 || Buffer.byteLength(options.passwordDerivationSecret) < 32) {
    throw new Error('Matrix secrets must be at least 32 bytes');
  }
  if (options.registrationIngressToken !== undefined && options.registrationIngressToken.length < 32) {
    throw new Error('Matrix registration ingress token must be at least 32 characters');
  }
  const transport = options.fetch ?? globalThis.fetch.bind(globalThis);
  const password = (userId: string) => createHmac('sha256', options.passwordDerivationSecret)
    .update('khala-matrix-agent-password-v1\0').update(userId).digest('base64url');
  const humanPassword = (ownerId: OwnerId) => createHmac('sha256', options.passwordDerivationSecret)
    .update('khala-matrix-password-v1\0').update(ownerId).digest('base64url');
  const humanUserId = (ownerId: OwnerId) => ownerMatrixUserId(ownerId, options.serverName);
  const controlDevice = (ownerId: OwnerId) => `KHALA_CONTROL_${digest(ownerId).slice(0, 24)}`;

  async function call(path: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> | null }> {
    const headers = new Headers(init.headers);
    if (path === '/_synapse/admin/v1/register' && options.registrationIngressToken) {
      headers.set('X-Khala-Registration-Ingress', options.registrationIngressToken);
    }
    const response = await transport(`${options.homeserverOrigin}${path}`, {
      ...init, headers,
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: textObject(await response.json().catch(() => null)) };
  }

  async function login(userId: string, secret: string, deviceId: string) {
    const result = await call('/_matrix/client/v3/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'm.login.password', identifier: { type: 'm.id.user', user: userId },
        password: secret, device_id: deviceId,
        initial_device_display_name: 'Khala Agent',
      }),
    });
    if (result.status !== 200 || result.body?.user_id !== userId || result.body.device_id !== deviceId
      || typeof result.body.access_token !== 'string') return null;
    return result.body.access_token;
  }

  async function ensureAccount(identity: ReturnType<typeof agentMatrixIdentity>): Promise<boolean> {
    const profile = await call(`/_matrix/client/v3/profile/${encodeURIComponent(identity.userId)}`);
    if (profile.status === 200) return true;
    if (profile.status !== 404 || profile.body?.errcode !== 'M_NOT_FOUND') return false;
    const nonce = await call('/_synapse/admin/v1/register');
    if (nonce.status !== 200 || typeof nonce.body?.nonce !== 'string') return false;
    const secret = password(identity.userId);
    const mac = createHmac('sha1', options.registrationSharedSecret)
      .update(nonce.body.nonce).update('\0').update(identity.username).update('\0')
      .update(secret).update('\0').update('notadmin').digest('hex');
    const registered = await call('/_synapse/admin/v1/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: nonce.body.nonce, username: identity.username, password: secret, admin: false, mac }),
    });
    if (registered.status === 200 && registered.body?.user_id === identity.userId) return true;
    return registered.status === 400 && registered.body?.errcode === 'M_USER_IN_USE'
      && (await call(`/_matrix/client/v3/profile/${encodeURIComponent(identity.userId)}`)).status === 200;
  }

  async function member(roomId: RoomId, userId: string, token: string): Promise<'joined' | 'absent' | 'unavailable'> {
    const result = await call(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(userId)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (result.status === 200) return result.body?.membership === 'join' ? 'joined' : 'absent';
    return result.status === 404 || result.status === 403 ? 'absent' : 'unavailable';
  }

  function roomFromPairing(inviteRef: string): RoomId | null {
    const roomId = inviteRef.startsWith(PAIRING_INVITE_PREFIX) ? inviteRef.slice(PAIRING_INVITE_PREFIX.length) : '';
    return roomId.length > 0 && roomId.length <= 512 ? roomId as RoomId : null;
  }

  async function authorizedRoom(input: Readonly<{
    ownerId: OwnerId; principal?: { ownerId: OwnerId; verifiedEmail: string } | null;
    inviteRef: string; inviteEvidence?: InviteEvidence | null;
  }>): Promise<RoomId | null> {
    const paired = roomFromPairing(input.inviteRef);
    if (paired) return paired;
    if (!input.principal || input.principal.ownerId !== input.ownerId || !input.inviteEvidence) return null;
    const valid = await matchesInviteEvidence({
      store: options.store, secret: options.invitationHmacSecret, clock: options.clock,
      principal: input.principal as Parameters<typeof matchesInviteEvidence>[0]['principal'],
      inviteRef: input.inviteRef, expected: input.inviteEvidence,
    });
    return valid ? input.inviteEvidence.roomId : null;
  }

  const agents: AgentAdmissionPort = {
    async inspect(input) {
      try {
        const roomId = await authorizedRoom(input);
        if (!roomId) return { kind: 'rejected', code: 'forbidden' };
        const ownerToken = await login(humanUserId(input.ownerId), humanPassword(input.ownerId), controlDevice(input.ownerId));
        if (!ownerToken) return { kind: 'unavailable', retryable: true };
        if (await member(roomId, humanUserId(input.ownerId), ownerToken) !== 'joined') return { kind: 'rejected', code: 'forbidden' };
        const identity = agentMatrixIdentity(input.ownerId, input.session, options.serverName);
        return { kind: 'ok', value: { agentParticipantId: identity.participantId, roomId } };
      } catch { return { kind: 'unavailable', retryable: true }; }
    },
    async admit(input) {
      try {
        const roomId = await authorizedRoom(input);
        const identity = agentMatrixIdentity(input.ownerId, input.session, options.serverName);
        if (!roomId || roomId !== input.expectedRoomId || identity.participantId !== input.expectedAgentParticipantId) {
          return { kind: 'rejected', code: 'forbidden' };
        }
        const ownerToken = await login(humanUserId(input.ownerId), humanPassword(input.ownerId), controlDevice(input.ownerId));
        if (!ownerToken) return { kind: 'unavailable', retryable: true };
        if (await member(roomId, humanUserId(input.ownerId), ownerToken) !== 'joined') return { kind: 'rejected', code: 'forbidden' };
        if (!await ensureAccount(identity)) return { kind: 'unavailable', retryable: true };
        // A separate short-lived control device joins the account; the endpoint's
        // requested device remains distinct and owns its own crypto state.
        const agentToken = await login(identity.userId, password(identity.userId), `KHALA_JOIN_${digest(identity.userId).slice(0, 24)}`);
        if (!agentToken) return { kind: 'unavailable', retryable: true };
        if (await member(roomId, identity.userId, agentToken) !== 'joined') {
          const invited = await call(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`, {
            method: 'POST', headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' },
            body: JSON.stringify({ user_id: identity.userId }),
          });
          if (invited.status !== 200 && invited.status !== 409) return { kind: 'unavailable', retryable: true };
          const joined = await call(`/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
            method: 'POST', headers: { authorization: `Bearer ${agentToken}`, 'content-type': 'application/json' }, body: '{}',
          });
          if (joined.status !== 200 || joined.body?.room_id !== roomId) return { kind: 'outcome_unknown', operationId: input.operationId };
        }
        return { kind: 'ok', value: { agentParticipantId: identity.participantId, roomId } };
      } catch { return { kind: 'outcome_unknown', operationId: input.operationId }; }
    },
  };

  const deviceSession: AgentDeviceSessionPort = {
    async issue(binding: SessionBinding, roomId: RoomId) {
      try {
        const identity = agentMatrixIdentity(binding.ownerId, binding, options.serverName);
        if (identity.participantId !== binding.agentParticipantId) return null;
        const accessToken = await login(identity.userId, password(identity.userId), binding.deviceId);
        return accessToken ? {
          baseUrl: options.homeserverOrigin, userId: identity.userId,
          deviceId: binding.deviceId, accessToken, roomId,
          ownerUserId: humanUserId(binding.ownerId),
          ownerParticipantId: `human_${digest(humanUserId(binding.ownerId)).slice(0, 40)}`,
        } : null;
      } catch { return null; }
    },
  };
  async function publishedDeviceKey(binding: SessionBinding, algorithm: 'ed25519' | 'curve25519'): Promise<string | null> {
    try {
      const identity = agentMatrixIdentity(binding.ownerId, binding, options.serverName);
      if (identity.participantId !== binding.agentParticipantId) return null;
      const token = await login(identity.userId, password(identity.userId), `KHALA_JOIN_${digest(identity.userId).slice(0, 24)}`);
      if (!token) return null;
      const response = await call('/_matrix/client/v3/keys/query', {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ device_keys: { [identity.userId]: [binding.deviceId] } }),
      });
      if (response.status !== 200) return null;
      const users = textObject(response.body?.device_keys);
      const devices = textObject(users?.[identity.userId]);
      const device = textObject(devices?.[binding.deviceId]);
      const keys = textObject(device?.keys);
      const fingerprint = keys?.[`${algorithm}:${binding.deviceId}`];
      return device?.user_id === identity.userId && device.device_id === binding.deviceId
        && typeof fingerprint === 'string' && /^[A-Za-z0-9+/]{43}=?$/u.test(fingerprint)
        ? fingerprint : null;
    } catch { return null; }
  }
  const normalize = (key: unknown): string | null => {
    if (typeof key !== 'string' || !/^[A-Za-z0-9+/]{43}=?$/u.test(key)) return null;
    const bytes = Buffer.from(key, 'base64');
    const canonical = bytes.toString('base64').replace(/=+$/u, '');
    return bytes.length === 32 && canonical === key.replace(/=+$/u, '') ? canonical : null;
  };
  async function inspectWithToken(binding: SessionBinding, userId: string, token: string, expected: string): Promise<MatrixDeviceStatus> {
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const path = `/_matrix/client/v3/devices/${encodeURIComponent(binding.deviceId)}`;
    try {
      const device = await call(path, { headers });
      if (device.status === 404 && device.body?.errcode === 'M_NOT_FOUND') return 'removed';
      if (device.status !== 200 || device.body?.device_id !== binding.deviceId) return 'unavailable';
      const queried = await call('/_matrix/client/v3/keys/query', { method: 'POST', headers,
        body: JSON.stringify({ device_keys: { [userId]: [binding.deviceId] } }) });
      const failures = queried.body?.failures === undefined ? {} : textObject(queried.body.failures);
      if (queried.status !== 200 || !failures || Object.keys(failures).length) return 'unavailable';
      const users = textObject(queried.body?.device_keys);
      const devices = textObject(users?.[userId]);
      const published = textObject(devices?.[binding.deviceId]);
      if (published?.user_id !== userId || published.device_id !== binding.deviceId) return 'unavailable';
      const key = normalize(textObject(published.keys)?.[`curve25519:${binding.deviceId}`]);
      return key === null ? 'unavailable' : key === expected ? 'present' : 'replaced';
    } catch { return 'unavailable'; }
  }
  async function inspectPublishedDevice(binding: SessionBinding, expectedCurve25519: string): Promise<MatrixDeviceStatus> {
    try {
      const identity = agentMatrixIdentity(binding.ownerId, binding, options.serverName);
      const expected = normalize(expectedCurve25519);
      if (identity.participantId !== binding.agentParticipantId || !expected) return 'unavailable';
      const token = await login(identity.userId, password(identity.userId), `KHALA_JOIN_${digest(identity.userId).slice(0, 24)}`);
      return token ? inspectWithToken(binding, identity.userId, token, expected) : 'unavailable';
    } catch { return 'unavailable'; }
  }
  async function removePublishedDeviceWithUIA(binding: SessionBinding, expectedCurve25519: string): Promise<MatrixDeviceRemoval> {
    const identity = agentMatrixIdentity(binding.ownerId, binding, options.serverName);
    const controlId = `KHALA_JOIN_${digest(identity.userId).slice(0, 24)}`;
    if (identity.participantId !== binding.agentParticipantId || binding.deviceId === controlId) return 'forbidden';
    const expected = normalize(expectedCurve25519);
    if (!expected) return 'unavailable';
    let attempted = false;
    try {
      const secret = password(identity.userId);
      const token = await login(identity.userId, secret, controlId);
      if (!token) return 'unavailable';
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
      const path = `/_matrix/client/v3/devices/${encodeURIComponent(binding.deviceId)}`;
      const inspect = () => inspectWithToken(binding, identity.userId, token, expected);
      const before = await inspect();
      if (before !== 'present') return before;
      let response: Awaited<ReturnType<typeof call>>;
      try {
        attempted = true;
        response = await call(path, { method: 'DELETE', headers, body: '{}' });
        if (response.status === 401) {
          const session = response.body?.session;
          const flows = response.body?.flows;
          if (typeof session !== 'string' || !session || session.length > 4096 || !Array.isArray(flows)
            || !flows.some(flow => {
              const stages = textObject(flow)?.stages;
              return Array.isArray(stages) && stages.length === 1 && stages[0] === 'm.login.password';
            })) return 'reauthentication_required';
          // UIA may take time: do not delete a replacement found after the challenge.
          const challenged = await inspect();
          if (challenged !== 'present') return challenged;
          response = await call(path, { method: 'DELETE', headers, body: JSON.stringify({ auth: {
            type: 'm.login.password', session, identifier: { type: 'm.id.user', user: identity.userId }, password: secret,
          } }) });
        }
      } catch {
        const observed = await inspect();
        return observed === 'removed' || observed === 'replaced' ? observed : 'outcome_unknown';
      }
      if (response.status === 401) return 'reauthentication_required';
      if (response.status === 403) return 'forbidden';
      const observed = await inspect();
      return observed === 'removed' || observed === 'replaced' ? observed : 'outcome_unknown';
    } catch { return attempted ? 'outcome_unknown' : 'unavailable'; }
  }
  async function inspectAgentRoomMembership(ownerId: OwnerId, session: SessionRef, roomId: RoomId) {
    try {
      const identity = agentMatrixIdentity(ownerId, session, options.serverName);
      // The account may not exist yet: admission persists its claim before
      // registration. Inspect membership as the joined owner so an agent login
      // failure cannot strand reconciliation or be mistaken for non-application.
      const ownerUser = humanUserId(ownerId);
      const token = await login(ownerUser, humanPassword(ownerId), controlDevice(ownerId));
      if (!token || await member(roomId, ownerUser, token) !== 'joined') return 'unavailable';
      const result = await call(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(identity.userId)}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (result.status === 404 && result.body?.errcode === 'M_NOT_FOUND') return 'absent';
      const membership = result.body?.membership;
      if (result.status !== 200 || typeof membership !== 'string') return 'unavailable';
      return membership === 'join' ? 'joined'
        : ['leave', 'ban', 'invite', 'knock'].includes(membership) ? 'absent' : 'unavailable';
    } catch { return 'unavailable'; }
  }
  return {
    agents, deviceSession, inspectAgentRoomMembership,
    removePublishedDeviceWithUIA, inspectPublishedDevice,
    publishedDeviceFingerprint: binding => publishedDeviceKey(binding, 'ed25519'),
    publishedDeviceIdentityKey: binding => publishedDeviceKey(binding, 'curve25519'),
  };
}
