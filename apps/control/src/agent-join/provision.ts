import { createHash, createHmac } from 'node:crypto';
import type { AgentCredentials } from '@khala/contracts/m1/agent-join';
import type { OwnerId } from '@khala/contracts/messaging/index';

export type AgentProvisionerOptions = Readonly<{
  homeserverOrigin: string; serverName: string; registrationSharedSecret: string; registrationIngressToken: string | null;
  passwordDerivationSecret: string; joinSecret: string; fetch?: typeof globalThis.fetch; timeoutMs?: number;
}>;
export type AgentProvisioner = {
  agentUserId(joinId: string, ownerId: OwnerId): string;
  provision(input: Readonly<{ joinId: string; ownerId: OwnerId; label: string; roomId: string }>):
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
    async provision(input) {
    try {
      const { username, userId, deviceId } = agentIdentity(input.joinId, input.ownerId, options.serverName, options.joinSecret);
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
      try {
        await request(`/_matrix/client/v3/profile/${encodeURIComponent(userId)}/displayname`, { method: 'PUT',
          headers: { authorization: `Bearer ${loggedIn.access_token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ displayname: input.label }) });
      } catch { /* Display names are best effort, including repairs on registration retries. */ }
      return { kind: 'ok', credentials: { homeserver: options.homeserverOrigin, userId, deviceId, accessToken: loggedIn.access_token, roomId: input.roomId } };
    } catch { return { kind: 'unavailable' }; }
  } };
}
