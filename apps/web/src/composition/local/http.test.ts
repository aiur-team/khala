import { describe, expect, it, vi } from 'vitest';
import { createLocalHttp, decodeEmpty, localChannelPath, localRoomPath } from './http';
import { decodeOwnerUsernameResult } from '@khala/contracts/m1/local';
const origin = 'http://127.0.0.1:47830';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
describe('local HTTP', () => {
  it('uses exact URLs and GET headers without mutation guard', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(200, { username: 'kevin' }));
    const http = createLocalHttp({ origin, fetch });
    expect(http.origin).toBe(origin);
    expect(await http.get('/api/local/profile', decodeOwnerUsernameResult)).toEqual({ kind: 'ok', value: { username: 'kevin' } });
    expect(fetch).toHaveBeenCalledWith(`${origin}/api/local/profile`, expect.objectContaining({ method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } }));
  });
  it.each(['POST', 'PUT', 'DELETE'] as const)('guards %s and serializes the body', async method => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    expect(await createLocalHttp({ origin, fetch }).send(method, '/api/local/channels', { name: 'a' }, decodeEmpty)).toEqual({ kind: 'ok', value: null });
    expect(fetch).toHaveBeenCalledWith(`${origin}/api/local/channels`, expect.objectContaining({ method, credentials: 'same-origin', body: '{"name":"a"}', headers: { accept: 'application/json', 'content-type': 'application/json', 'x-khala-local': '1' } }));
  });
  it('preserves string error reasons and falls back for non-JSON errors', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(400, { error: 'invalid_username', reason: 'reserved' })).mockResolvedValueOnce(new Response('offline', { status: 503 }));
    const http = createLocalHttp({ origin, fetch });
    expect(await http.get('/profile', decodeEmpty)).toEqual({ kind: 'error', status: 400, code: 'invalid_username', reason: 'reserved' });
    expect(await http.get('/profile', decodeEmpty)).toEqual({ kind: 'error', status: 503, code: 'http_503' });
  });
  it.each([json(200, {}), new Response('{', { headers: { 'content-type': 'application/json' } }), new Response('not JSON')])('rejects invalid success payloads', async response => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    expect(await createLocalHttp({ origin, fetch }).get('/profile', decodeEmpty)).toEqual({ kind: 'error', status: 200, code: 'invalid_response' });
  });
  it('handles network failures', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('offline'));
    expect(await createLocalHttp({ origin, fetch }).get('/profile', decodeEmpty)).toEqual({ kind: 'unavailable' });
  });
  it('aborts on the deadline and caller cancellation', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const http = createLocalHttp({ origin, fetch, timeoutMs: 20 });
    expect(await http.get('/profile', decodeEmpty)).toEqual({ kind: 'unavailable' });
    expect(await http.get('/profile', decodeEmpty, AbortSignal.abort())).toEqual({ kind: 'unavailable' });
  });
  it('allows a per-call deadline longer than the default', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_url, init) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(null, { status: 204 })), 40);
      init!.signal!.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
    }));
    expect(await createLocalHttp({ origin, fetch, timeoutMs: 20 }).get('/profile', decodeEmpty, undefined, 1000)).toEqual({ kind: 'ok', value: null });
  });
  it.each([`${origin}/`, `${origin}/path`, 'garbage'])('rejects inexact origin %s', value => {
    expect(() => createLocalHttp({ origin: value })).toThrow(new TypeError('local helper origin must be an exact origin'));
  });
  it('encodes path identifiers and appends tails exactly', () => {
    expect(localRoomPath('!abc:local', '/send')).toBe('/api/local/rooms/!abc%3Alocal/send');
    expect(localRoomPath('!abc:local')).toBe('/api/local/rooms/!abc%3Alocal');
    expect(localChannelPath('!abc:local')).toBe('/api/local/channels/!abc%3Alocal');
    expect(localChannelPath('a/b', '/link')).toBe('/api/local/channels/a%2Fb/link');
    expect(decodeEmpty(undefined).ok).toBe(false);
  });
});
