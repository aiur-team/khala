import { LOCAL_OWNER_DEVICE_ID, LOCAL_OWNER_ID, LOCAL_OWNER_USER_ID, decodeOwnerProfileView } from '@khala/contracts/m1/local';
import { checkName } from '@khala/contracts/m1/names';
import type { DevicePort, DeviceView } from '@khala/contracts/messaging/devices';
import type { AuthPrincipal, IdentityPort, ParticipantView } from '@khala/contracts/messaging/identity';
import type { DeviceId, OwnerId, ParticipantId } from '@khala/contracts/messaging/ids';
import { ok, rejected, unavailable } from '@khala/contracts/messaging/outcomes';
import { LOCAL_PROFILE_PATH, type LocalHttp } from './http';

export const LOCAL_PRINCIPAL: AuthPrincipal = Object.freeze({ v: 1, ownerId: LOCAL_OWNER_ID as OwnerId,
  providerIssuer: 'khala-local', providerSubject: 'owner', verifiedEmail: '', sessionExpiresAt: '9999-12-31T23:59:59.000Z' });
export type LocalSession = Readonly<{ identity: IdentityPort; device: DevicePort; participant(): ParticipantView | null; noteUsername(username: string): void }>;
export function createLocalSession(http: LocalHttp): LocalSession {
  let participant: ParticipantView | null = null;
  function noteUsername(username: string): void {
    const checked = checkName(username, 'username');
    if (!checked.ok || checked.name !== username || participant?.displayName === username) return;
    participant = Object.freeze({ participantId: LOCAL_OWNER_USER_ID as ParticipantId, kind: 'human', ownerId: LOCAL_OWNER_ID as OwnerId,
      displayName: username, deviceIds: Object.freeze([LOCAL_OWNER_DEVICE_ID as DeviceId]) });
  }
  const identity: IdentityPort = {
    async current(options) {
      try {
        const result = await http.get(LOCAL_PROFILE_PATH, decodeOwnerProfileView, options?.signal);
        if (result.kind === 'ok') { noteUsername(result.value.username); return { kind: 'signed_in', principal: LOCAL_PRINCIPAL }; }
      } catch { /* The helper may be offline. */ }
      return { kind: 'unavailable', retryable: true };
    },
    async beginSignIn() { return rejected('invalid_return_path'); },
    async signOut() { return unavailable(); },
  };
  const fresh: DeviceView = Object.freeze({ deviceId: null, state: 'new', generation: 1, reason: null });
  const ready: DeviceView = Object.freeze({ deviceId: LOCAL_OWNER_DEVICE_ID as DeviceId, state: 'ready', generation: 1, reason: null });
  let view = fresh;
  const listeners = new Set<(view: DeviceView) => void>();
  function set(next: DeviceView): void {
    if (next === view) return;
    view = next;
    for (const listener of listeners) { try { listener(next); } catch { /* Isolate observers. */ } }
  }
  const device: DevicePort = {
    async ensureReady(ownerId, options) {
      if (options?.signal?.aborted) return unavailable();
      if (ownerId !== LOCAL_OWNER_ID) return rejected('owner_mismatch');
      set(ready); return ok(ready);
    },
    current: () => view,
    observe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async stop() { set(fresh); },
  };
  return { identity, device, participant: () => participant, noteUsername };
}
