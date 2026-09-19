import {
  decodeAdmission,
  decodeAuthPrincipal,
  decodeDeviceId,
  decodeInviteState,
  decodeShareGrant,
  isSameOriginReturnPath,
  sameProviderIdentity,
  outcomeUnknown,
  rejected,
  unavailable,
  type AdmissionPort,
  type AdmissionRejection,
  type ContentLimits,
  type IdentityPort,
  type IdentityState,
  type OperationResult,
} from '@khala/contracts/messaging/index';
import type { CredentialSource } from '@khala/messaging/browser-device/index';

const ME_PATH = '/api/human/me';
const LOGIN_PATH = '/api/human/auth/login';
const LOGOUT_PATH = '/api/human/auth/logout';
const SHARE_PATH = '/api/human/invitations/share';
const INSPECT_PATH = '/api/human/invitations/inspect';
const ADMIT_PATH = '/api/human/invitations/admit';
const MATRIX_SESSION_PATH = '/api/human/messaging/session';

type Fetch = typeof globalThis.fetch;

export type HumanBrowserApiOptions = Readonly<{
  origin: string;
  homeserverOrigin: string;
  limits: ContentLimits;
  fetch?: Fetch;
  deviceIds?: Readonly<{ get(ownerId: string): string | null; put(ownerId: string, deviceId: string): void }>;
}>;

export type HumanBrowserApi = Readonly<{
  identity: IdentityPort;
  admission: AdmissionPort;
  credentials: CredentialSource;
}>;

function exactHttpsOrigin(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.origin !== value
    || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('human browser API origin must be an exact https origin');
  }
  return parsed.origin;
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
  const origin = exactHttpsOrigin(options.origin);
  const configuredHomeserverOrigin = exactHttpsOrigin(options.homeserverOrigin);
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  let csrfToken: string | null = null;
  const deviceIds = options.deviceIds ?? {
    get: (ownerId: string) => globalThis.localStorage.getItem(`khala.matrix.device.v1:${ownerId}`),
    put: (ownerId: string, deviceId: string) => globalThis.localStorage.setItem(`khala.matrix.device.v1:${ownerId}`, deviceId),
  };

  const identityUnavailable = (): IdentityState => ({ kind: 'unavailable', retryable: true });

  async function readCurrent(signal?: AbortSignal): Promise<IdentityState> {
    try {
      const response = await request(`${origin}${ME_PATH}`, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        ...(signal ? { signal } : {}),
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
        ...(signal ? { signal } : {}),
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
          ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
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
        requestedDeviceId = stored ?? `KH_WEB_${crypto.randomUUID().replaceAll('-', '')}`;
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
      try { homeserverOrigin = exactHttpsOrigin(session.homeserverOrigin as string); } catch { return { kind: 'unavailable' }; }
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

  return { identity, admission, credentials };
}
