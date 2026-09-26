import { describe, expect, it } from 'vitest';
import { baseView } from '../make-external/fixtures/views';
import { createHttpMakeExternalPort } from './make-external-port';

const ORIGIN = 'http://127.0.0.1:4871';

function port(respond: (init: RequestInit) => Response | Promise<Response>, over: Record<string, number> = {}) {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return respond(init);
  }) as unknown as typeof globalThis.fetch;
  return { seen, port: createHttpMakeExternalPort({ origin: ORIGIN, requestSecret: 'secret', fetch, ...over }) };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('make-external HTTP port', () => {
  it('reads the view with the request secret and decodes it strictly', async () => {
    const { seen, port: p } = port(() => json(200, baseView));
    expect(await p.view('internal-planning')).toEqual({ kind: 'ok', view: baseView });
    expect(seen[0]!.url).toBe(`${ORIGIN}/api/v1/channels/internal-planning/make-external`);
    expect((seen[0]!.init.headers as Record<string, string>)['x-khala-request-secret']).toBe('secret');
    expect(await port(() => json(200, { ...baseView, extra: 1 })).port.view('c')).toEqual({ kind: 'unavailable' });
  });

  it('maps statuses to finite results', async () => {
    const view = (status: number) => port(() => json(status, { error: { code: 'x' } })).port.view('c');
    expect(await view(401)).toEqual({ kind: 'session_ended' });
    expect(await view(403)).toEqual({ kind: 'absent' });
    expect(await view(404)).toEqual({ kind: 'absent' });
    expect(await view(503)).toEqual({ kind: 'unavailable' });
    const act = (status: number) => port(() => json(status, {})).port.act('c', { kind: 'resume', operationId: 'op' });
    expect(await act(401)).toEqual({ kind: 'session_ended' });
    expect(await act(404)).toEqual({ kind: 'absent' });
    expect(await act(503)).toEqual({ kind: 'outcome_unknown' });
  });

  it('accepts only the exact action envelope', async () => {
    const act = (body: unknown) => port(() => json(200, body)).port.act('c', { kind: 'resume', operationId: 'op' });
    expect(await act({ v: 1, view: baseView, rejection: 'not_ready' })).toEqual({ kind: 'ok', view: baseView, rejection: 'not_ready' });
    expect(await act({ v: 1, view: baseView, rejection: 'bogus' })).toEqual({ kind: 'outcome_unknown' });
    expect(await act({ v: 1, view: baseView, rejection: null, extra: 1 })).toEqual({ kind: 'outcome_unknown' });
  });

  it('gives up on a hung server: a read is unavailable, an action is an unknown outcome', async () => {
    const hang = (init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
    });
    const { port: p } = port(hang, { viewTimeoutMs: 10, actTimeoutMs: 10 });
    expect(await p.view('c')).toEqual({ kind: 'unavailable' });
    expect(await p.act('c', { kind: 'commit', operationId: 'op' })).toEqual({ kind: 'outcome_unknown' });
  });
});
