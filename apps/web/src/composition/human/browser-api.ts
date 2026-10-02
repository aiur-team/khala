import {
  decodeAdmission,
  decodeAuthPrincipal,
  decodeDeviceId,
  decodeInviteState,
  decodeParticipantView,
  decodeShareGrant,
  decodeHumanChannelLinkResult,
  decodePersonalChannelLinkResult,
  isSameOriginReturnPath,
  sameProviderIdentity,
  outcomeUnknown,
  rejected,
  unavailable,
  type AdmissionPort,
  type AdmissionRejection,
  type ContentLimits,
  type DeviceId,
  type OwnerId,
  type RoomId,
  type IdentityPort,
  type IdentityState,
  type OperationResult,
  type ParticipantView,
} from '@khala/contracts/messaging/index';
import { createIndexedDbMarkerStore, hasOwnerCryptoStore, type CredentialSource } from '@khala/messaging/browser-device/index';
import { parsePublicOrigin } from './hosted-config';
import type { HumanChannelLinks } from './channel-links';

const ME_PATH = '/api/human/me';
const LOGIN_PATH = '/api/human/auth/login';
const LOGOUT_PATH = '/api/human/auth/logout';
const SHARE_PATH = '/api/human/invitations/share';
const LINK_RESOLVE_PATH = '/api/human/channel-link/resolve';
const LINK_PERSONAL_PATH = '/api/human/channel-link/personal';
const INSPECT_PATH = '/api/human/invitations/inspect';
const ADMIT_PATH = '/api/human/invitations/admit';
const MATRIX_SESSION_PATH = '/api/human/messaging/session';
const MATRIX_PARTICIPANTS_PATH = '/api/human/messaging/participants';
export type BrowserParticipantSession = Readonly<{ deviceId: string; matrixAccessToken: string }>;
type Fetch = typeof globalThis.fetch;

export type HumanBrowserApiOptions = Readonly<{
  origin: string;
  homeserverOrigin: string;
  allowInsecureLoopback?: boolean;
  limits: ContentLimits;
  fetch?: Fetch;
  timeoutMs?: number;
  deviceIds?: Readonly<{ get(ownerId: string): string | null; put(ownerId: string, deviceId: string): void }>;
  existingDevice?: (ownerId: OwnerId, deviceId: string | null) => Promise<Readonly<{ markerDeviceId: string | null; hasDivergentCryptoStore: boolean }>>;
  /** Supply only from an authenticated, owner/device-bound replacement admission. */
  authorizeReplacement?: (principal: Parameters<CredentialSource['resolve']>[0], deviceId: DeviceId) => Promise<boolean>;
}>;

export type HumanBrowserApi = Readonly<{
  identity: IdentityPort;
  admission: AdmissionPort;
  channelLinks: HumanChannelLinks;
  credentials: CredentialSource;
  participants: Readonly<{
    resolve(userIds: readonly string[], signal?: AbortSignal, roomId?: RoomId, targetParticipantIds?: readonly ParticipantView['participantId'][], session?: BrowserParticipantSession): Promise<ReadonlyMap<string, ParticipantView> | null>;
  }>;
}>;

function exactHttpsOrigin(value: string, allowInsecureLoopback = false): string {
  const parsed = parsePublicOrigin(value, allowInsecureLoopback);
  if (parsed !== value) {
    throw new Error('human browser API origin must be an exact https origin');
  }
  return parsed;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

async function jsonObject(response: Response): Promise<Record<string, unknown> | null> {
  if (!(response.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  try {
    const value: unknown = await response.json();
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

const ADMISSION_REJECTIONS = new Set<AdmissionRejection>([
  'auth_required',
  'expired',
  'revoked',
  'identity_mismatch',
  'forbidden',
  'operation_mismatch',
]);

async function failedOperation<T>(response: Response, operationId: string): Promise<OperationResult<T, AdmissionRejection>> {
  const body = await jsonObject(response);
  if (response.status === 502 && body?.code === 'outcome_unknown' && body.operationId === operationId) {
    return outcomeUnknown(operationId);
  }
  const code = body?.code === 'authentication_required' ? 'auth_required' : body?.code;
  if (typeof code === 'string' && ADMISSION_REJECTIONS.has(code as AdmissionRejection)) {
    return rejected(code as AdmissionRejection);
  }
  return unavailable();
}

/**
 * Creates the same-origin browser adapters for the finite human control API.
 * Response bodies are decoded at this boundary; malformed or invented success
 * values remain unavailable rather than entering feature state.
 */
export function createHumanBrowserApi(options: HumanBrowserApiOptions): HumanBrowserApi {
  const origin = exactHttpsOrigin(options.origin, options.allowInsecureLoopback);
  const configuredHomeserverOrigin = exactHttpsOrigin(options.homeserverOrigin, options.allowInsecureLoopback);
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 10_000;
  let csrfToken: string | null = null;
  const deviceIds = options.deviceIds ?? {
    get: (ownerId: string) => globalThis.localStorage.getItem(`khala.matrix.device.v1:${ownerId}`),
    put: (ownerId: string, deviceId: string) => globalThis.localStorage.setItem(`khala.matrix.device.v1:${ownerId}`, deviceId),
  };
  const existingDevice = options.existingDevice ?? (async (ownerId: OwnerId, deviceId: string | null) => ({
    markerDeviceId: (await createIndexedDbMarkerStore().get(ownerId))?.deviceId ?? null,
    hasDivergentCryptoStore: await hasOwnerCryptoStore(ownerId, deviceId as DeviceId | null),
  }));

  const identityUnavailable = (): IdentityState => ({ kind: 'unavailable', retryable: true });

  function requestSignal(signal?: AbortSignal): AbortSignal {
    return AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  }

  async function readCurrent(signal?: AbortSignal): Promise<IdentityState> {
    try {
      const response = await request(`${origin}${ME_PATH}`, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        signal: requestSignal(signal),
      });
      if (response.status === 401) {
        csrfToken = null;
        return { kind: 'signed_out' as const };
      }
      if (response.status !== 200) return identityUnavailable();
      const body = await jsonObject(response);
      if (body === null || !hasExactKeys(body, ['principal', 'csrfToken']) || typeof body.csrfToken !== 'string') return identityUnavailable();
      const principal = decodeAuthPrincipal(body.principal);
      if (!principal.ok) return identityUnavailable();
      csrfToken = body.csrfToken;
      return { kind: 'signed_in' as const, principal: principal.value };
    } catch {
      return identityUnavailable();
    }
  }

  async function mutation(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response | null> {
    if (csrfToken === null) {
      const state = await readCurrent(signal);
      if (state.kind !== 'signed_in') return null;
    }
    try {
      return await request(`${origin}${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-khala-csrf': csrfToken!,
        },
        body: JSON.stringify(body),
        signal: requestSignal(signal),
      });
    } catch {
      return null;
    }
  }

  const identity: IdentityPort = {
    current: options => readCurrent(options?.signal),

    async beginSignIn(returnPath) {
      if (!isSameOriginReturnPath(returnPath)) return rejected('invalid_return_path');
      const url = new URL(LOGIN_PATH, origin);
      url.searchParams.set('return_to', returnPath);
      return { kind: 'ok', value: { kind: 'navigate', url: url.href } };
    },

    async signOut(operationId, callOptions) {
      const response = await mutation(LOGOUT_PATH, { operationId }, callOptions?.signal);
      if (response === null) return unavailable();
      const body = await jsonObject(response);
      if (response.status === 200 && body !== null && hasExactKeys(body, ['kind']) && body.kind === 'signed_out') {
        csrfToken = null;
        return { kind: 'ok', value: null };
      }
      if (response.status === 502 && body?.code === 'outcome_unknown' && body.operationId === operationId) {
        return outcomeUnknown(operationId);
      }
      return unavailable();
    },
  };

  const admission: AdmissionPort = {
    async share(input, callOptions) {
      const response = await mutation(SHARE_PATH, input, callOptions?.signal);
      if (response === null) return unavailable();
      if (response.status !== 200) return failedOperation(response, input.operationId);
      const body = await jsonObject(response);
      if (body === null || !hasExactKeys(body, ['kind', 'value']) || body.kind !== 'ok') return unavailable();
      const grant = decodeShareGrant(body.value);
      return grant.ok ? { kind: 'ok', value: grant.value } : unavailable();
    },

    async inspect(inviteRef, callOptions) {
      const url = new URL(INSPECT_PATH, origin);
      url.searchParams.set('invite', inviteRef);
      try {
        const response = await request(url, {
          method: 'GET',
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
          signal: requestSignal(callOptions?.signal),
        });
        if (response.status === 401) return 'auth_required';
        if (response.status !== 200) return 'unavailable';
        const body = await jsonObject(response);
        if (body === null || !hasExactKeys(body, ['state'])) return 'unavailable';
        const state = decodeInviteState(body.state);
        return state.ok ? state.value : 'unavailable';
      } catch {
        return 'unavailable';
      }
    },

    async admit(input, callOptions) {
      const response = await mutation(ADMIT_PATH, input, callOptions?.signal);
      if (response === null) return unavailable();
      if (response.status !== 200) return failedOperation(response, input.operationId);
      const body = await jsonObject(response);
      if (body === null || !hasExactKeys(body, ['kind', 'value']) || body.kind !== 'ok') return unavailable();
      const admitted = decodeAdmission(body.value, options.limits);
      return admitted.ok ? { kind: 'ok', value: admitted.value } : unavailable();
    },
  };

  const credentials: CredentialSource = {
    async resolve(principal, signal) {
      const identity = await readCurrent(signal);
      if (identity.kind !== 'signed_in' || !sameProviderIdentity(identity.principal, principal)) return { kind: 'unavailable' };
      let requestedDeviceId: string;
      try {
        const stored = deviceIds.get(principal.ownerId);
        const existing = await existingDevice(principal.ownerId, stored);
        requestedDeviceId = stored ?? `KH_WEB_${crypto.randomUUID().replaceAll('-', '')}`;
        const decodedCandidate = decodeDeviceId(requestedDeviceId);
        if (!decodedCandidate.ok) return { kind: 'unavailable' };
        if ((existing.markerDeviceId !== null && existing.markerDeviceId !== stored)
          || (existing.markerDeviceId === null && existing.hasDivergentCryptoStore)) {
          if (!options.authorizeReplacement || !await options.authorizeReplacement(principal, decodedCandidate.value)) {
            return { kind: 'unavailable', reason: 'recovery_required' };
          }
        }
        if (stored === null) deviceIds.put(principal.ownerId, requestedDeviceId);
      } catch {
        return { kind: 'unavailable' };
      }
      const decodedRequested = decodeDeviceId(requestedDeviceId);
      if (!decodedRequested.ok) return { kind: 'unavailable' };
      const response = await mutation(MATRIX_SESSION_PATH, { deviceId: decodedRequested.value }, signal);
      if (response === null || response.status !== 200) return { kind: 'unavailable' };
      const envelope = await jsonObject(response);
      if (envelope === null || !hasExactKeys(envelope, ['session']) || !isObject(envelope.session)) return { kind: 'unavailable' };
      const session = envelope.session;
      if (!hasExactKeys(session, ['homeserverOrigin', 'userId', 'accessToken', 'deviceId', 'publishedFingerprint'])
        || typeof session.homeserverOrigin !== 'string'
        || typeof session.userId !== 'string' || !session.userId.startsWith('@')
        || typeof session.accessToken !== 'string' || session.accessToken.length === 0
        || session.publishedFingerprint !== null && typeof session.publishedFingerprint !== 'string') return { kind: 'unavailable' };
      let homeserverOrigin: string;
      try { homeserverOrigin = exactHttpsOrigin(session.homeserverOrigin as string, options.allowInsecureLoopback); } catch { return { kind: 'unavailable' }; }
      if (homeserverOrigin !== configuredHomeserverOrigin) return { kind: 'unavailable' };
      const deviceId = decodeDeviceId(session.deviceId);
      if (!deviceId.ok || deviceId.value !== decodedRequested.value) return { kind: 'unavailable' };
      return {
        kind: 'ok',
        session: {
          deviceId: deviceId.value,
          publishedFingerprint: session.publishedFingerprint as string | null,
          credentials: { homeserverOrigin, userId: session.userId, accessToken: session.accessToken },
        },
      };
    },
  };

  const participants = {
    async resolve(userIds: readonly string[], signal?: AbortSignal, roomId?: RoomId, targetParticipantIds?: readonly ParticipantView['participantId'][], session?: BrowserParticipantSession): Promise<ReadonlyMap<string, ParticipantView> | null> {
      if (userIds.length > 100 || new Set(userIds).size !== userIds.length) return null;
      if (roomId && (!session?.deviceId || !session.matrixAccessToken)) return null;
      const response = await mutation(MATRIX_PARTICIPANTS_PATH, { userIds, ...(roomId ? { roomId, ...session } : {}), ...(targetParticipantIds?.length ? { targetParticipantIds } : {}) }, signal);
      if (response === null || response.status !== 200) return null;
      const envelope = await jsonObject(response);
      if (envelope === null || !hasExactKeys(envelope, ['participants']) || !Array.isArray(envelope.participants)) return null;
      const resolved = new Map<string, ParticipantView>();
      for (const value of envelope.participants) {
        if (!isObject(value) || !(hasExactKeys(value, ['matrixUserId', 'participantId', 'ownerId', 'displayName'])
          || hasExactKeys(value, ['matrixUserId', 'participantId', 'ownerId', 'displayName', 'kind']))
          || typeof value.matrixUserId !== 'string') return null;
        const participant = decodeParticipantView({
          participantId: value.participantId,
          kind: value.kind ?? 'human',
          ownerId: value.ownerId,
          displayName: value.displayName,
          deviceIds: [],
        }, options.limits);
        if (!participant.ok || resolved.has(value.matrixUserId)) return null;
        resolved.set(value.matrixUserId, participant.value);
      }
      return userIds.every(userId => resolved.has(userId))
        && [...resolved.entries()].every(([userId, participant]) => userIds.includes(userId) || targetParticipantIds?.includes(participant.participantId)) ? resolved : null;
    },
  };

  const channelLinks: HumanChannelLinks = {
    async resolve(channelUrl, signal) {
      const response = await mutation(LINK_RESOLVE_PATH, { v: 1, channelUrl }, signal);
      const decoded = response && decodeHumanChannelLinkResult(await jsonObject(response));
      return decoded?.ok ? decoded.value : { v: 1, kind: 'unavailable' };
    },
    async personal(roomId, signal) {
      const response = await mutation(LINK_PERSONAL_PATH, { v: 1, roomId }, signal);
      const decoded = response && decodePersonalChannelLinkResult(await jsonObject(response));
      return decoded?.ok && (decoded.value.kind !== 'personal_link' || new URL(decoded.value.shareUrl).origin === origin)
        ? decoded.value : { v: 1, kind: 'unavailable' };
    },
  };
  return { identity, admission, channelLinks, credentials, participants };
}
