// `loopback-browser-v1`, the ownership method KHA-144 proved. The connector opens
// the owner's own signed-in browser at the service's authorize page, and a
// one-time code comes back only to a loopback listener on this machine (RFC 8252,
// PKCE S256). The code, then the grant, are bound to this connector's key. The
// human's sign-in cookie never reaches the connector or the model, and nothing
// here can approve or release messages.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BootstrapAdmissionPort, AdmissionOutcome, OwnershipOutcome, OwnershipPort } from './ports';
import type { ProofSigner } from './proof';
import { readBounded } from './discovery';

export const DEFAULT_OWNER_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 16_384;

export type LoopbackOwnershipOptions = Readonly<{
  signer: ProofSigner;
  /** Opens the owner's default browser on this machine. Supplied by the harness adapter. */
  openBrowser(url: string): Promise<void>;
  fetch?: typeof fetch;
  /** How long the owner has to finish in the browser. */
  timeoutMs?: number;
  /** Trusted local time in epoch milliseconds. */
  clock?: () => number;
}>;

type Callback =
  | Readonly<{ kind: 'code'; code: string }>
  | Readonly<{ kind: 'denied' }>
  | Readonly<{ kind: 'timeout' }>;

export function createLoopbackOwnership(options: LoopbackOwnershipOptions): OwnershipPort {
  const transport = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_OWNER_TIMEOUT_MS;
  const clock = options.clock ?? Date.now;

  return {
    methods: ['loopback-browser-v1'],
    async prove({ method, descriptor, session, deviceId }): Promise<OwnershipOutcome> {
      if (method !== 'loopback-browser-v1') return { kind: 'refused', code: 'ownership_required' };
      const state = randomBytes(16).toString('base64url');
      const verifier = randomBytes(32).toString('base64url');
      const callbackPath = `/khala/callback/${randomBytes(8).toString('hex')}`;
      const listener = await listenForCallback(callbackPath, state, timeoutMs);
      try {
        const authorize = new URL(descriptor.authorize);
        authorize.search = new URLSearchParams({
          invite: descriptor.invite,
          harness: session.harness,
          session_id: session.sessionId,
          generation: String(session.generation),
          device_id: deviceId,
          jkt: options.signer.jkt,
          redirect_uri: `http://127.0.0.1:${listener.port}${callbackPath}`,
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          code_challenge_method: 'S256',
          state,
        }).toString();
        try {
          await options.openBrowser(authorize.href);
        } catch {
          // No browser on this machine: the owner cannot complete this method here.
          return { kind: 'refused', code: 'ownership_required' };
        }
        const callback = await listener.result;
        if (callback.kind === 'denied') return { kind: 'refused', code: 'admission_denied' };
        if (callback.kind === 'timeout') return { kind: 'refused', code: 'ownership_required' };

        const origin = new URL(descriptor.token).origin;
        const response = await post(transport, descriptor.token, origin, {
          code: callback.code,
          code_verifier: verifier,
          harness: session.harness,
          session_id: session.sessionId,
          generation: session.generation,
          device_id: deviceId,
        }, { dpop: options.signer.proof('POST', descriptor.token) });
        if (response.kind === 'failed') return { kind: 'unavailable' };
        if (response.status === 403) return { kind: 'refused', code: 'admission_denied' };
        if (response.status !== 200) return response.status >= 500 || response.status === 429 ? { kind: 'unavailable' } : { kind: 'refused', code: 'ownership_required' };
        const body = response.body as { grant?: unknown; expires_at?: unknown } | null;
        if (typeof body?.grant !== 'string' || !Number.isSafeInteger(body.expires_at) || (body.expires_at as number) <= clock()) {
          return { kind: 'refused', code: 'ownership_required' };
        }
        return {
          kind: 'granted',
          grant: { method, redeem: descriptor.redeem, session, deviceId, expiresAt: body.expires_at as number, secret: body.grant },
        };
      } finally {
        listener.close();
      }
    },
  };
}

export type HttpAdmissionOptions = Readonly<{ signer: ProofSigner; fetch?: typeof fetch }>;

/** Redeems an ownership grant at the service's redeem endpoint. */
export function createHttpAdmission(options: HttpAdmissionOptions): BootstrapAdmissionPort {
  const transport = options.fetch ?? fetch;
  return {
    async redeem({ grant, operationId }): Promise<AdmissionOutcome> {
      const response = await post(transport, grant.redeem, new URL(grant.redeem).origin, {
        operation_id: operationId,
        harness: grant.session.harness,
        session_id: grant.session.sessionId,
        generation: grant.session.generation,
        device_id: grant.deviceId,
      }, {
        authorization: `DPoP ${grant.secret}`,
        dpop: options.signer.proof('POST', grant.redeem, grant.secret),
      });
      // The request may have reached the service: only a retry with this operation ID is safe.
      if (response.kind === 'failed') return response.sent ? { kind: 'outcome_unknown' } : { kind: 'unavailable' };
      const { status } = response;
      if (status === 401) return { kind: 'refused', code: 'ownership_required' };
      if (status === 403) return { kind: 'refused', code: 'admission_denied' };
      if (status === 409) return { kind: 'refused', code: 'binding_conflict' };
      if (status === 429 || status === 503) return { kind: 'unavailable' };
      if (status !== 200) return status >= 500 ? { kind: 'outcome_unknown' } : { kind: 'refused', code: 'admission_denied' };
      const body = response.body as { binding?: unknown; device_credential?: { secret?: unknown; expires_at?: unknown } } | null;
      const credential = body?.device_credential;
      if (!body || typeof body.binding !== 'object' || body.binding === null
        || typeof credential?.secret !== 'string' || !Number.isSafeInteger(credential.expires_at)) {
        return { kind: 'outcome_unknown' };
      }
      // The orchestrator decodes and checks the binding against what it asked for.
      return {
        kind: 'admitted',
        binding: body.binding as never,
        credential: { secret: credential.secret, expiresAt: credential.expires_at as number },
      };
    },
  };
}

type PostResult =
  | Readonly<{ kind: 'response'; status: number; body: unknown }>
  | Readonly<{ kind: 'failed'; sent: boolean }>;

/**
 * JSON POST to the service. `origin` is the service's own origin: the control
 * gateway requires it on state-changing requests, and a browser cannot forge it.
 * Authority comes from the proof and grant, never from this header.
 */
async function post(transport: typeof fetch, url: string, origin: string, body: unknown, headers: Record<string, string>): Promise<PostResult> {
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
    return { kind: 'failed', sent: true };
  }
  try {
    const bytes = await readBounded(response, MAX_RESPONSE_BYTES);
    if (bytes === null) return { kind: 'response', status: response.status, body: null };
    return { kind: 'response', status: response.status, body: bytes.length === 0 ? null : JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { kind: 'response', status: response.status, body: null };
  }
}

type Listener = Readonly<{ port: number; result: Promise<Callback>; close(): void }>;

/** One-shot loopback listener on 127.0.0.1 for the authorization callback. */
async function listenForCallback(path: string, state: string, timeoutMs: number): Promise<Listener> {
  let settle!: (callback: Callback) => void;
  const result = new Promise<Callback>(resolve => { settle = resolve; });
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const presented = url.searchParams.get('state') ?? '';
    if (request.method !== 'GET' || url.pathname !== path || !sameSecret(presented, state)) {
      response.writeHead(400, { 'content-type': 'text/plain' }).end('Not a Khala callback.');
      return;
    }
    const code = url.searchParams.get('code');
    const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
    if (code) {
      response.writeHead(200, headers).end('<p>Your agent is finishing setup. You can close this tab.</p>');
      settle({ kind: 'code', code });
    } else {
      response.writeHead(200, headers).end('<p>Your agent was not connected. You can close this tab.</p>');
      settle({ kind: 'denied' });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const timer = setTimeout(() => settle({ kind: 'timeout' }), timeoutMs);
  return {
    port: (server.address() as AddressInfo).port,
    result,
    close() {
      clearTimeout(timer);
      server.closeAllConnections();
      server.close();
    },
  };
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
