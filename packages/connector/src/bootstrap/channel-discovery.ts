// Channel-less discovery authorization for an already-running native session.
// The credential is deliberately held only in this client instance. Durable
// bootstrap storage owns the proof key, never this request-only authority.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type DiscoveryCredential,
  decodeDiscoveryCredential,
  validateDiscoveryCredential,
} from '@khala/contracts/messaging/index';
import { admitsExistingSessionRoute } from '../route-admission';
import { isAcceptableOrigin, readBounded } from './discovery';
import type { SessionClaim, SessionInspectionPort, VerifiedSession } from './ports';
import type { ProofSigner } from './proof';

export const CHANNEL_DISCOVERY_AUTHORIZE_PATH = '/api/human/channel-discovery/bootstrap/authorize';
export const CHANNEL_DISCOVERY_TOKEN_PATH = '/api/agent/channel-discovery/bootstrap/token';
export const DEFAULT_CHANNEL_DISCOVERY_TIMEOUT_MS = 120_000;

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 16_384;
const ONE_TIME_CODE = /^[A-Za-z0-9_-]{43}$/;

export type ChannelDiscoveryCredentialClientOptions = Readonly<{
  signer: ProofSigner;
  sessions: SessionInspectionPort;
  /** Exact configured service origins. An acceptable URL is not trusted merely because it parses. */
  trustedOrigins: readonly string[];
  openBrowser(url: string): Promise<void>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  clock?: () => number;
  allowExperimentalAgentListener?: boolean;
}>;

export type ChannelDiscoveryAuthorizeInput = Readonly<{
  origin: string;
  session: SessionClaim;
}>;

export type ChannelDiscoveryAuthorizationOutcome =
  | Readonly<{ kind: 'authorized'; credential: DiscoveryCredential }>
  | Readonly<{ kind: 'denied' }>
  | Readonly<{ kind: 'cancelled' }>
  | Readonly<{ kind: 'timed_out' }>
  | Readonly<{ kind: 'rejected'; code: DiscoveryBootstrapRejection }>
  | Readonly<{ kind: 'unavailable' }>
  /** The code may have been consumed and authority issued; fresh consent is required. */
  | Readonly<{ kind: 'outcome_unknown' }>;

export type ChannelDiscoveryRefreshOutcome =
  | Readonly<{ kind: 'refreshed'; credential: DiscoveryCredential }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'rejected'; code: DiscoveryBootstrapRejection }>
  | Readonly<{ kind: 'unavailable' }>
  /** Rotation may have completed, so the old local value is discarded. */
  | Readonly<{ kind: 'outcome_unknown' }>;

export type DiscoveryBootstrapRejection =
  | 'untrusted_origin'
  | 'session_missing'
  | 'unsupported_harness'
  | 'session_changed'
  | 'invalid_grant'
  | 'invalid_response';

export interface ChannelDiscoveryCredentialClient {
  authorize(
    input: ChannelDiscoveryAuthorizeInput,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<ChannelDiscoveryAuthorizationOutcome>;
  refresh(): Promise<ChannelDiscoveryRefreshOutcome>;
  /** Returns only a currently live in-memory value. */
  current(): DiscoveryCredential | null;
  invalidate(): void;
}

type HeldCredential = Readonly<{
  credential: DiscoveryCredential;
  claim: SessionClaim;
  session: VerifiedSession;
  origin: string;
}>;

type Callback =
  | Readonly<{ kind: 'code'; code: string }>
  | Readonly<{ kind: 'denied' }>
  | Readonly<{ kind: 'cancelled' }>
  | Readonly<{ kind: 'timeout' }>;

type PostResult =
  | Readonly<{ kind: 'response'; status: number; body: unknown }>
  | Readonly<{ kind: 'failed' }>;

export function createChannelDiscoveryCredentialClient(
  options: ChannelDiscoveryCredentialClientOptions,
): ChannelDiscoveryCredentialClient {
  for (const origin of options.trustedOrigins) {
    if (!isAcceptableOrigin(origin)) throw new Error('trusted origins must be exact https (or loopback http) origins');
  }
  const trusted = new Set(options.trustedOrigins);
  const transport = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHANNEL_DISCOVERY_TIMEOUT_MS;
  const clock = options.clock ?? Date.now;
  let held: HeldCredential | null = null;

  async function inspect(claim: SessionClaim): Promise<
    | Readonly<{ kind: 'verified'; session: VerifiedSession }>
    | Readonly<{ kind: 'rejected'; code: 'session_missing' | 'unsupported_harness' }>
    | Readonly<{ kind: 'unavailable' }>
  > {
    let result: Awaited<ReturnType<SessionInspectionPort['inspect']>>;
    try {
      result = await options.sessions.inspect(claim);
    } catch {
      return { kind: 'unavailable' };
    }
    if (result.kind === 'unavailable') return result;
    if (result.kind === 'missing') return { kind: 'rejected', code: 'session_missing' };
    if (result.kind === 'unsupported') return { kind: 'rejected', code: 'unsupported_harness' };
    if (result.session.harness !== claim.harness || result.session.sessionId !== claim.sessionId
      || !admitsExistingSessionRoute(
        result.capabilities,
        result.session.harness,
        options.allowExperimentalAgentListener ?? false,
      )) return { kind: 'rejected', code: 'unsupported_harness' };
    return { kind: 'verified', session: result.session };
  }

  async function acceptCredential(
    body: unknown,
    current: Readonly<{
      requester?: DiscoveryCredential['requester']['principal'];
      origin: string;
      session: VerifiedSession;
    }>,
  ): Promise<DiscoveryCredential | null> {
    if (!isExactCredentialResponse(body)) return null;
    const decoded = decodeDiscoveryCredential(body.credential);
    if (!decoded.ok) return null;
    const requester = current.requester ?? decoded.value.requester.principal;
    const validity = await validateDiscoveryCredential(decoded.value, {
      requester,
      origin: current.origin,
      proofKeyThumbprint: options.signer.jkt,
      sessionGeneration: current.session.generation,
      nowMs: clock(),
    });
    return validity === 'valid' ? decoded.value : null;
  }

  return {
    async authorize(input, callOptions) {
      if (!trusted.has(input.origin)) return { kind: 'rejected', code: 'untrusted_origin' };
      if (isAborted(callOptions?.signal)) return { kind: 'cancelled' };

      const inspected = await inspect(input.session);
      if (inspected.kind !== 'verified') return inspected;
      if (isAborted(callOptions?.signal)) return { kind: 'cancelled' };

      const state = randomBytes(16).toString('base64url');
      const verifier = randomBytes(32).toString('base64url');
      const callbackPath = `/khala/channel-discovery/callback/${randomBytes(8).toString('hex')}`;
      let listener: Listener;
      try {
        listener = await listenForDiscoveryCallback(callbackPath, state, timeoutMs, callOptions?.signal);
      } catch {
        return { kind: 'unavailable' };
      }
      const redirectUri = `http://127.0.0.1:${listener.port}${callbackPath}`;
      const authorizeUrl = new URL(CHANNEL_DISCOVERY_AUTHORIZE_PATH, input.origin);
      authorizeUrl.search = new URLSearchParams({
        redirect_uri: redirectUri,
        state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        origin: input.origin,
        harness: inspected.session.harness,
        session_id: inspected.session.sessionId,
        generation: String(inspected.session.generation),
        proof_jkt: options.signer.jkt,
      }).toString();

      try {
        try {
          await options.openBrowser(authorizeUrl.href);
        } catch {
          return { kind: 'unavailable' };
        }
        const callback = await listener.result;
        if (callback.kind === 'denied') return { kind: 'denied' };
        if (callback.kind === 'cancelled') return { kind: 'cancelled' };
        if (callback.kind === 'timeout') return { kind: 'timed_out' };

        // The callback is the commit boundary. Do not let a late local abort
        // cancel a request whose code may be consumed by the service.
        const tokenUrl = `${input.origin}${CHANNEL_DISCOVERY_TOKEN_PATH}`;
        const response = await postJson(transport, tokenUrl, input.origin, {
          grant_type: 'authorization_code',
          code: callback.code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          harness: inspected.session.harness,
          session_id: inspected.session.sessionId,
          generation: inspected.session.generation,
        }, { dpop: options.signer.proof('POST', tokenUrl) });
        if (response.kind === 'failed') {
          held = null;
          return { kind: 'outcome_unknown' };
        }
        if (response.status === 403) return { kind: 'denied' };
        if (response.status === 429) return { kind: 'unavailable' };
        // The service can fail after credential issuance but before it can
        // prove limiter finalization. Once the code exchange was submitted,
        // any 5xx therefore has an indeterminate issuance outcome.
        if (response.status >= 500) {
          held = null;
          return { kind: 'outcome_unknown' };
        }
        if (response.status !== 200) return { kind: 'rejected', code: 'invalid_grant' };
        const accepted = await acceptCredential(response.body, { origin: input.origin, session: inspected.session });
        if (accepted === null) return { kind: 'rejected', code: 'invalid_response' };
        held = { credential: accepted, claim: input.session, session: inspected.session, origin: input.origin };
        return { kind: 'authorized', credential: accepted };
      } finally {
        listener.close();
      }
    },

    async refresh() {
      const current = held;
      if (current === null || clock() >= Date.parse(current.credential.expiresAt)) {
        held = null;
        return { kind: 'missing' };
      }
      const inspected = await inspect(current.claim);
      if (inspected.kind === 'unavailable') return inspected;
      if (inspected.kind === 'rejected') {
        held = null;
        return inspected;
      }
      if (!sameSession(inspected.session, current.session)) {
        held = null;
        return { kind: 'rejected', code: 'session_changed' };
      }

      const tokenUrl = `${current.origin}${CHANNEL_DISCOVERY_TOKEN_PATH}`;
      const response = await postJson(transport, tokenUrl, current.origin, {
        grant_type: 'refresh_token',
        harness: inspected.session.harness,
        session_id: inspected.session.sessionId,
        generation: inspected.session.generation,
      }, {
        authorization: `DPoP ${current.credential.credentialRef}`,
        dpop: options.signer.proof('POST', tokenUrl, current.credential.credentialRef),
      });
      if (response.kind === 'failed') {
        held = null;
        return { kind: 'outcome_unknown' };
      }
      if (response.status === 429) return { kind: 'unavailable' };
      if (response.status >= 500) {
        // The service can fail after committing CAS rotation (for example,
        // when limiter finalization becomes unprovable). The old value cannot
        // be claimed current once a refresh request reached the service.
        held = null;
        return { kind: 'outcome_unknown' };
      }
      if (response.status !== 200) {
        held = null;
        return { kind: 'rejected', code: 'invalid_grant' };
      }
      const accepted = await acceptCredential(response.body, {
        requester: current.credential.requester.principal,
        origin: current.origin,
        session: inspected.session,
      });
      if (accepted === null) {
        // A 200 can mean rotation already committed. Never keep claiming that
        // the previous plaintext remains current after an unusable response.
        held = null;
        return { kind: 'rejected', code: 'invalid_response' };
      }
      held = { ...current, credential: accepted, session: inspected.session };
      return { kind: 'refreshed', credential: accepted };
    },

    current() {
      if (held !== null && clock() >= Date.parse(held.credential.expiresAt)) held = null;
      return held?.credential ?? null;
    },

    invalidate() {
      held = null;
    },
  };
}

type Listener = Readonly<{ port: number; result: Promise<Callback>; close(): void }>;

async function listenForDiscoveryCallback(
  path: string,
  state: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Listener> {
  let settle!: (callback: Callback) => void;
  let settled = false;
  const result = new Promise<Callback>(resolve => {
    settle = callback => {
      if (settled) return;
      settled = true;
      resolve(callback);
    };
  });
  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  };
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const presentedStates = url.searchParams.getAll('state');
    const codes = url.searchParams.getAll('code');
    const errors = url.searchParams.getAll('error');
    const validState = presentedStates.length === 1 && sameSecret(presentedStates[0]!, state);
    const parameterNames = [...url.searchParams.keys()];
    const exactParameters = parameterNames.length === 2
      && parameterNames.every(name => name === 'state' || name === 'code' || name === 'error');
    if (request.method !== 'GET' || url.pathname !== path || !validState || !exactParameters) {
      response.writeHead(400, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end('Not a Khala channel discovery callback.');
      return;
    }
    if (codes.length === 1 && ONE_TIME_CODE.test(codes[0]!) && errors.length === 0) {
      response.writeHead(200, headers).end('<p>Channel discovery is authorized. You can close this tab.</p>');
      settle({ kind: 'code', code: codes[0]! });
      return;
    }
    if (codes.length === 0 && errors.length === 1 && errors[0] === 'access_denied') {
      response.writeHead(200, headers).end('<p>Channel discovery was cancelled. You can close this tab.</p>');
      settle({ kind: 'denied' });
      return;
    }
    response.writeHead(400, headers).end('<p>The channel discovery callback was invalid. You can close this tab.</p>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const timer = setTimeout(() => settle({ kind: 'timeout' }), timeoutMs);
  const onAbort = () => settle({ kind: 'cancelled' });
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted === true) onAbort();
  return {
    port: (server.address() as AddressInfo).port,
    result,
    close() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      server.closeAllConnections();
      server.close();
    },
  };
}

async function postJson(
  transport: typeof fetch,
  url: string,
  origin: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<PostResult> {
  let response: Response;
  try {
    response = await transport(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', origin, ...headers },
      body: JSON.stringify(body),
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { kind: 'failed' };
  }
  const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    await response.body?.cancel().catch(() => undefined);
    return { kind: 'response', status: response.status, body: null };
  }
  try {
    const bytes = await readBounded(response, MAX_RESPONSE_BYTES);
    if (bytes === null || bytes.length === 0) return { kind: 'response', status: response.status, body: null };
    return { kind: 'response', status: response.status, body: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
  } catch {
    return { kind: 'response', status: response.status, body: null };
  }
}

function isExactCredentialResponse(value: unknown): value is Readonly<{ credential: unknown }> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === 'credential';
}

function sameSession(left: VerifiedSession, right: VerifiedSession): boolean {
  return left.harness === right.harness && left.sessionId === right.sessionId && left.generation === right.generation;
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}
