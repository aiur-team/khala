// Same-origin JSON client for the loopback server's human-cookie routes. The
// cookie alone is never a credential: every call also carries the per-session
// request secret. A refused session is reported as `auth_failed`.

import { API, REQUEST_SECRET_HEADER } from '@khala/messaging/local/http/index';

export type HumanReply = Readonly<{ status: number; body: unknown }> | 'network' | 'auth_failed';

export interface HumanClient {
  get(path: string, signal?: AbortSignal): Promise<HumanReply>;
  post(path: string, body: unknown, signal?: AbortSignal): Promise<HumanReply>;
}

export type HumanClientOptions = Readonly<{
  origin: string;
  requestSecret: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}>;

export function createHumanClient(options: HumanClientOptions): HumanClient {
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function call(path: string, method: 'GET' | 'POST', body: unknown, signal?: AbortSignal): Promise<HumanReply> {
    let response: Response;
    try {
      response = await request(`${options.origin}${path}`, {
        method,
        credentials: 'same-origin',
        headers: {
          accept: 'application/json',
          [REQUEST_SECRET_HEADER]: options.requestSecret,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
      });
    } catch {
      return 'network';
    }
    if (response.status === 401) return 'auth_failed';
    let parsed: unknown = null;
    if ((response.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      try { parsed = await response.json(); } catch { parsed = null; }
    }
    return { status: response.status, body: parsed };
  }

  return {
    get: (path, signal) => call(path, 'GET', undefined, signal),
    post: (path, body, signal) => call(path, 'POST', body, signal),
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The ordinary channel read, used only for the owner-facing channel name. */
export const channelReadPath = (channelId: string): string => API.channel(channelId);

/** The `code` of a `{v:1, kind:'rejected', code}` reply, or `null`. */
export function rejectionCode(body: unknown): string | null {
  return isRecord(body) && typeof body.code === 'string' ? body.code : null;
}
