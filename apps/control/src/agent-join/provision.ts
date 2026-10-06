import { createHash, createHmac } from 'node:crypto';
import type { AgentCredentials } from '@khala/contracts/m1/agent-join';
import type { OwnerId } from '@khala/contracts/messaging/index';

export type AgentProvisionerOptions = Readonly<{
  homeserverOrigin: string; serverName: string; registrationSharedSecret: string; registrationIngressToken: string | null;
  passwordDerivationSecret: string; joinSecret: string; fetch?: typeof globalThis.fetch; timeoutMs?: number;
}>;
export type AgentProvisioner = {
  agentUserId(joinId: string, ownerId: OwnerId): string;
  setDisplayName(userId: string, name: string): Promise<boolean>;
  provision(input: Readonly<{ joinId: string; identityId?: string; ownerId: OwnerId; label: string; roomId: string }>):
    Promise<{ kind: 'ok'; credentials: AgentCredentials } | { kind: 'unavailable' }>;
};
export function agentIdentity(joinId: string, ownerId: OwnerId, serverName: string, joinSecret: string): { username: string; userId: string; deviceId: string } {
  const ownerHash = createHash('sha256').update(ownerId).digest('hex').slice(0, 8);
  const rand = [...createHmac('sha256', joinSecret).update(`khala-agent-join-rand-v1\0${joinId}`).digest().subarray(0, 6)]
    .map(byte => 'abcdefghijklmnopqrstuvwxyz0123456789'[byte % 36]).join('');
  const username = `agent-${ownerHash}-${rand}`;
  const deviceId = `KH_AGENT_${createHmac('sha256', joinSecret).update(`khala-agent-join-device-v1\0${joinId}`).digest('hex').slice(0, 8)}`;
  return { username, userId: `@${username}:${serverName}`, deviceId };
}
export function createAgentProvisioner(options: AgentProvisionerOptions): AgentProvisioner {
  const fetch = options.fetch ?? globalThis.fetch;
  const request = (path: string, init: RequestInit) => fetch(`${options.homeserverOrigin}${path}`, {
    ...init, signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  return {
    agentUserId: (joinId, ownerId) => agentIdentity(joinId, ownerId, options.serverName, options.joinSecret).userId,
    async setDisplayName(userId, name) {
      let token: string | null = null;
      try {
        const deviceId = `KH_AGENT_CTL_${createHmac('sha256', options.joinSecret).update(`khala-agent-ctl-device-v1\0${userId}`).digest('hex').slice(0, 8)}`;
        const password = createHmac('sha256', options.passwordDerivationSecret).update(`khala-agent-password-v1\0${userId}`).digest('base64url');
        const login = await request('/_matrix/client/v3/login', { method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'm.login.password', identifier: { type: 'm.id.user', user: userId }, password,
            device_id: deviceId, initial_device_display_name: 'Khala agent control' }) });
        if (login.status !== 200) return false;
        const body = await login.json() as { user_id?: unknown; device_id?: unknown; access_token?: unknown } | null;
        if (typeof body?.access_token !== 'string' || !body.access_token) return false;
        token = body.access_token;
        if (body.user_id !== userId || body.device_id !== deviceId) return false;
        const response = await request(`/_matrix/client/v3/profile/${encodeURIComponent(userId)}/displayname`, {
          method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ displayname: name }) });
        return response.status === 200;
      } catch { return false; }
      finally {
        if (token) {
          try { await request('/_matrix/client/v3/logout', { method: 'POST', headers: { authorization: `Bearer ${token}` } }); }
          catch { /* Logout must not change the confirmed PUT result. */ }
        }
      }
    },
    async provision(input) {
    try {
      const { username, userId } = agentIdentity(input.identityId ?? input.joinId, input.ownerId, options.serverName, options.joinSecret);
      const { deviceId } = agentIdentity(input.joinId, input.ownerId, options.serverName, options.joinSecret);
      const password = createHmac('sha256', options.passwordDerivationSecret).update(`khala-agent-password-v1\0${userId}`).digest('base64url');
      const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json' };
      if (options.registrationIngressToken) headers['X-Khala-Registration-Ingress'] = options.registrationIngressToken;
      const nonceResponse = await request('/_synapse/admin/v1/register', { headers });
      const nonceBody = await nonceResponse.json() as { nonce?: unknown } | null;
      if (nonceResponse.status !== 200 || typeof nonceBody?.nonce !== 'string') return { kind: 'unavailable' };
      const nonce = nonceBody.nonce;
      const mac = createHmac('sha1', options.registrationSharedSecret).update(`${nonce}\0${username}\0${password}\0notadmin`).digest('hex');
      const registration = await request('/_synapse/admin/v1/register', { method: 'POST', headers,
        body: JSON.stringify({ nonce, username, password, admin: false, mac, displayname: input.label }),
      });
      const registered = await registration.json() as { user_id?: unknown; errcode?: unknown } | null;
      if (!(registration.status === 200 && registered?.user_id === userId)
        && !(registration.status === 400 && registered?.errcode === 'M_USER_IN_USE')) return { kind: 'unavailable' };
      const login = await request('/_matrix/client/v3/login', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'm.login.password', identifier: { type: 'm.id.user', user: userId }, password, device_id: deviceId, initial_device_display_name: 'Khala agent' }),
      });
      if (login.status !== 200) return { kind: 'unavailable' };
      const loggedIn = await login.json() as { user_id?: unknown; device_id?: unknown; access_token?: unknown } | null;
      if (loggedIn?.user_id !== userId || loggedIn.device_id !== deviceId || typeof loggedIn.access_token !== 'string') return { kind: 'unavailable' };
      // Registration sets the initial display name. Do not PUT the global
      // profile here: Synapse asynchronously regenerates bare member events,
      // erasing the inviter and listening mode on restored memberships.
      return { kind: 'ok', credentials: { homeserver: options.homeserverOrigin, userId, deviceId, accessToken: loggedIn.access_token, roomId: input.roomId } };
    } catch { return { kind: 'unavailable' }; }
  } };
}
