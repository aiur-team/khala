import { type AgentCredentials, type AgentJoinCreated } from '@khala/contracts/m1/agent-join';
import { harnessInfo, isHarnessId, type HarnessId } from '@khala/contracts/m1/harness';
import { restartHelper } from './local/lifecycle';
import { validateAgentName } from '@khala/contracts/messaging/agent-names';
import { KhalaClientError } from './client';

export function parseChannelLink(link: string): { origin: string } | null {
  try {
    const url = new URL(link);
    if (link.length > 2048 || url.href !== link || url.username || url.password || url.search || url.hash
      || !/^\/join\/[A-Za-z0-9_-]{8,256}$/u.test(url.pathname)
      || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return null;
    return { origin: url.origin };
  } catch { return null; }
}

type JoinSession = { origin: string; joinId: string; pollSecret: string };
type FetchDeps = { fetch?: typeof fetch; env?: NodeJS.ProcessEnv; restartHelper?: (origin: string) => Promise<boolean> };
type PollOptions = FetchDeps & {
  intervalMs?: number; timeoutMs?: number; signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; now?: () => number;
};

function fail(reason: string): never { throw new KhalaClientError('internal_error', reason); }
function expired(reason: string): never { throw new KhalaClientError('join_expired', reason); }
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function parseUrl(value: unknown): URL | null {
  if (!nonempty(value)) return null;
  try { return new URL(value); } catch { return null; }
}
async function json(response: Response): Promise<Record<string, unknown>> {
  try { return record(await response.json()); } catch { return {}; }
}
function serverCode(body: Record<string, unknown>): unknown {
  return typeof body['error'] === 'string' ? body['error'] : typeof body['code'] === 'string' ? body['code'] : undefined;
}
function gatewayError(status: number, code: unknown): void {
  // Only fixed reasons reach errors, never arbitrary server text or request IDs.
  if (status === 403 && code === 'forbidden_origin') fail('forbidden_origin');
  if (status === 405) fail('method_not_allowed');
  if (status === 413 && code === 'payload_too_large') fail('payload_too_large');
  if (status === 503 && code === 'feature_unavailable') fail('feature_unavailable');
  if (status === 503 && code === 'unavailable') fail('unavailable');
}
async function post(url: URL, origin: string, body: unknown, deps: FetchDeps, pollSecret?: string): Promise<Response> {
  try {
    return await (deps.fetch ?? fetch)(url.href, {
      method: 'POST', headers: { 'content-type': 'application/json', origin,
        ...(pollSecret === undefined ? {} : { authorization: `Bearer ${pollSecret}` }) },
      body: JSON.stringify(body),
    });
  } catch { return fail('network'); }
}

export async function requestJoin(input: { link: string; harness: HarnessId; label: string; sessionId?: string; rejoinSecret?: string }, deps: FetchDeps = {}): Promise<AgentJoinCreated & { origin: string }> {
  const parsed = parseChannelLink(input.link);
  if (!parsed) throw new KhalaClientError('invalid_link', 'invalid_link');
  if (!isHarnessId(input.harness)) fail('invalid_harness');
  const label = validateAgentName(input.label);
  if (!label.ok || [...label.name].length > 40) fail('invalid_label');
  const { origin } = parsed;
  const url = new URL('/api/agent/join', origin);
  const base = { link: input.link, harness: input.harness, label: label.name };
  const rejoin = input.sessionId !== undefined && input.rejoinSecret !== undefined;
  let response = await post(url, origin, rejoin ? { ...base, sessionId: input.sessionId, rejoinSecret: input.rejoinSecret } : base, deps);
  let body = await json(response);
  let code = serverCode(body);
  // Release-order compatibility: control planes and machine-wide helpers released before rejoin
  // reject any extra join field with 400 invalid_link, before consuming the link. Retry once with
  // the original three-field body, which costs only the rejoin (a fresh "-N" member). A server that
  // knows rejoin never answers invalid_link to well-formed fields, so this only fires on old servers
  // or a link that the retry rejects again. See compat/join-request-compat.test.ts.
  if (rejoin && response.status === 400 && code === 'invalid_link') {
    response = await post(url, origin, base, deps);
    body = await json(response);
    code = serverCode(body);
  }
  if (response.status === 400 && code === 'invalid_harness') {
    if (new URL(origin).protocol === 'https:') {
      throw new KhalaClientError('update_required', `Khala's hosted service does not accept ${harnessInfo(input.harness).displayName} agents yet. Local channels work now.`);
    }
    if (await (deps.restartHelper ?? (origin => restartHelper(origin, deps.env, deps.fetch ? { fetch: deps.fetch } : {})))(origin)) {
      response = await post(url, origin, rejoin ? { ...base, sessionId: input.sessionId, rejoinSecret: input.rejoinSecret } : base, deps);
      body = await json(response);
      code = serverCode(body);
      if (rejoin && response.status === 400 && code === 'invalid_link') {
        response = await post(url, origin, base, deps);
        body = await json(response);
        code = serverCode(body);
      }
    }
  }
  if (response.status !== 201) {
    if (response.status === 400 && code === 'invalid_link') throw new KhalaClientError('invalid_link', 'invalid_link');
    if (response.status === 400 && (code === 'invalid_label' || code === 'invalid_harness')) fail(code);
    if (response.status === 404) {
      if (code === 'link_unavailable') throw new KhalaClientError('link_unavailable', 'link_unavailable');
      fail('route_not_found');
    }
    if (response.status === 429) fail('rate_limited');
    gatewayError(response.status, code);
    fail('protocol');
  }
  const { joinId, pollSecret, confirmUrl, expiresAt } = body;
  const confirm = parseUrl(confirmUrl);
  if (!nonempty(joinId) || !nonempty(pollSecret) || !nonempty(confirmUrl)
    || !confirm || confirm.origin !== origin || confirm.pathname !== '/agent/confirm'
    || !nonempty(expiresAt) || !Number.isFinite(Date.parse(expiresAt))) fail('protocol');
  return { joinId, pollSecret, confirmUrl, expiresAt, origin, ...(body['autoConfirmed'] === true ? { autoConfirmed: true as const } : {}) };
}

function endpoint(input: JoinSession, path: string): URL {
  try {
    const url = new URL(path, input.origin);
    url.searchParams.set('joinId', input.joinId);
    return url;
  } catch { return fail('protocol'); }
}
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(); return; }
    const abort = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
function credentials(value: unknown): AgentCredentials {
  const { homeserver, userId, accessToken, deviceId, roomId, transport } = record(value);
  if (!nonempty(homeserver) || !parseUrl(homeserver) || !nonempty(userId)
    || !nonempty(accessToken) || !nonempty(deviceId) || !nonempty(roomId)) fail('protocol');
  return { homeserver, userId, accessToken, deviceId, roomId, ...(transport === 'local' ? { transport: 'local' as const } : {}) };
}

export async function pollJoin(input: JoinSession, options: PollOptions = {}): Promise<AgentCredentials> {
  const { timeoutMs = 600_000, intervalMs = 2000, signal } = options;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0 || !Number.isFinite(timeoutMs) || timeoutMs < 0) fail('protocol');
  if (signal?.aborted) fail('network');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    const stop = (error: KhalaClientError): void => {
      // Settle the safe error before aborting any in-flight fetch/body read.
      reject(error);
      controller.abort();
    };
    timer = setTimeout(() => stop(new KhalaClientError('join_expired', 'timeout')), timeoutMs);
    abort = () => stop(new KhalaClientError('internal_error', 'network'));
    signal?.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([pollUntilDeadline(input, { ...options, signal: controller.signal }), stopped]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}

async function pollUntilDeadline(input: JoinSession, options: PollOptions): Promise<AgentCredentials> {
  const { intervalMs = 2000, timeoutMs = 600_000, signal, now = Date.now } = options;
  const deadline = now() + timeoutMs;
  const url = endpoint(input, '/api/agent/join/poll');
  for (;;) {
    if (signal?.aborted) fail('network');
    if (now() > deadline) expired('timeout');
    let response: Response | undefined;
    try {
      response = await (options.fetch ?? fetch)(url.href, {
        method: 'GET', headers: { authorization: `Bearer ${input.pollSecret}` }, ...(signal ? { signal } : {}),
      });
    } catch { /* Transient network failures are pending until the deadline. */ }
    if (signal?.aborted) fail('network');
    if (now() > deadline) expired('timeout');
    if (response) {
      if (response.status !== 200) {
        try { await response.body?.cancel(); } catch { /* Cleanup must not change retry behavior. */ }
      }
      if (response.status === 404) expired('not_found');
      if (response.status === 200) {
        const body = await json(response);
        if (signal?.aborted) fail('network');
        if (now() > deadline) expired('timeout');
        if (body['state'] === 'confirmed') return credentials(body['credentials']);
        if (body['state'] === 'claimed' || body['state'] === 'expired') expired(body['state']);
        if (body['state'] !== 'pending') fail('protocol');
      } else if (response.status !== 429 && !(response.status >= 500 && response.status <= 599)) fail('protocol');
    }
    if (now() + intervalMs > deadline) expired('timeout');
    try { await (options.sleep ?? sleep)(intervalMs, signal); } catch { fail('network'); }
  }
}

export async function reportReady(input: JoinSession, deps: FetchDeps = {}): Promise<void> {
  const response = await post(endpoint(input, '/api/agent/join/ready'), input.origin, {}, deps, input.pollSecret);
  if (response.status === 204) return;
  const code = serverCode(await json(response));
  if (response.status === 404) fail('ready_not_found');
  if (response.status === 409) fail('not_confirmed');
  gatewayError(response.status, code);
  fail('protocol');
}
