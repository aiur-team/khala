import { type Decoded, decodeWith, fail } from '@khala/contracts/messaging/decode';

export type LocalHttpResult<T> = { kind: 'ok'; value: T } | { kind: 'error'; status: number; code: string; reason?: string } | { kind: 'unavailable' };
export interface LocalHttp {
  readonly origin: string;
  get<T>(path: string, decode: (value: unknown) => Decoded<T>, signal?: AbortSignal, timeoutMs?: number): Promise<LocalHttpResult<T>>;
  send<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body: unknown, decode: (value: unknown) => Decoded<T>, signal?: AbortSignal, timeoutMs?: number): Promise<LocalHttpResult<T>>;
}
export const LOCAL_PROFILE_PATH = '/api/local/profile';
export const LOCAL_CHANNELS_PATH = '/api/local/channels';
export function localRoomPath(roomId: string, tail = ''): string {
  // khala-terminology-allow: helper API route path, never rendered
  return `/api/local/rooms/${encodeURIComponent(roomId)}${tail}`;
}
export const localChannelPath = (roomId: string, tail = ''): string => `/api/local/channels/${encodeURIComponent(roomId)}${tail}`;
export function decodeEmpty(value: unknown): Decoded<null> {
  return decodeWith(() => { if (value !== null) fail('', 'invalid_value'); return null; });
}
export function createLocalHttp(input: { origin: string; fetch?: typeof fetch; timeoutMs?: number }): LocalHttp {
  const { origin } = input;
  try { if (new URL(origin).origin !== origin) throw new TypeError(); }
  catch { throw new TypeError('local helper origin must be an exact origin'); }
  const request = input.fetch ?? globalThis.fetch.bind(globalThis);
  async function call<T>(method: string, path: string, body: unknown, decode: (value: unknown) => Decoded<T>, signal?: AbortSignal, timeoutMs?: number): Promise<LocalHttpResult<T>> {
    try {
      const combined = AbortSignal.any([AbortSignal.timeout(timeoutMs ?? input.timeoutMs ?? 10_000), ...(signal ? [signal] : [])]);
      const response = await request(`${origin}${path}`, {
        method, credentials: 'same-origin', signal: combined,
        headers: { accept: 'application/json', ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-khala-local': '1' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      let payload: unknown;
      if (response.status === 204) payload = null;
      else if (response.headers.get('content-type')?.startsWith('application/json')) {
        try { payload = await response.json(); } catch { if (combined.aborted) return { kind: 'unavailable' }; }
      }
      if (combined.aborted) return { kind: 'unavailable' };
      if (response.ok) {
        const decoded = decode(payload);
        return decoded.ok ? { kind: 'ok', value: decoded.value } : { kind: 'error', status: response.status, code: 'invalid_response' };
      }
      const error = typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? payload as Record<string, unknown> : null;
      return { kind: 'error', status: response.status,
        code: typeof error?.error === 'string' ? error.error : `http_${response.status}`,
        ...(typeof error?.reason === 'string' ? { reason: error.reason } : {}) };
    } catch { return { kind: 'unavailable' }; }
  }
  return { origin, get: (path, decode, signal, timeoutMs) => call('GET', path, undefined, decode, signal, timeoutMs),
    send: (method, path, body, decode, signal, timeoutMs) => call(method, path, body, decode, signal, timeoutMs) };
}
