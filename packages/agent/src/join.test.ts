import { afterEach, expect, it, vi } from 'vitest';
import type { Harness } from '@khala/contracts/m1/agent-join';
import { KhalaClientError } from './client';
import { parseChannelLink, pollJoin, reportReady, requestJoin } from './join';

const origin = 'https://khala.aiur.team';
const input = { link: `${origin}/join/AbCdEfGh12`, harness: 'claude' as const, label: 'Claude' };
const session = { origin, joinId: 'j_7Qx', pollSecret: 'ps_9f' };
const created = { joinId: session.joinId, pollSecret: session.pollSecret,
  confirmUrl: `${origin}/agent/confirm?joinId=j_7Qx`, expiresAt: '2026-10-02T10:10:00.000Z' };
const credentials = { homeserver: 'https://matrix.khala.aiur.team', userId: '@agent-1a2b3c4d-x9y8z7:khala.aiur.team',
  accessToken: 'syt_x', deviceId: 'KH_AGENT_0f3a9c21', roomId: '!abc:khala.aiur.team' };
const confirmed = { state: 'confirmed', credentials };
const reply = (status: number, body: unknown = {}): Response => new Response(status === 204 ? null : JSON.stringify(body), { status });
function fake(...queue: (Response | Error)[]) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', headers: Object.fromEntries(new Headers(init?.headers)), body: init?.body });
    const result = queue.shift();
    if (!result) throw new Error('fake queue empty');
    if (result instanceof Error) throw result;
    return result;
  };
  let time = 0;
  const sleeps: number[] = [];
  return { fetch, calls, sleeps, now: () => time,
    sleep: async (ms: number) => { sleeps.push(ms); time += ms; }, advance: (ms: number) => { time += ms; } };
}
async function rejects(promise: Promise<unknown>, code: string, reason: string) {
  const error = await promise.then(() => { throw new Error('expected rejection'); }, (error: unknown) => error);
  expect(error).toBeInstanceOf(KhalaClientError);
  expect(error).toMatchObject({ code, message: reason });
  for (const secret of ['ps_9f', 'syt_x', 'r1']) expect(String(error)).not.toContain(secret);
}
afterEach(() => vi.useRealTimers());

it('derives the origin from canonical HTTPS and loopback HTTP links', () => {
  expect(parseChannelLink(input.link)).toEqual({ origin });
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    expect(parseChannelLink(`http://${host}:8888/join/AbCdEfGh12`)).toEqual({ origin: `http://${host}:8888` });
  }
});
it.each([
  'http://khala.aiur.team/join/AbCdEfGh12', 'https://x.test/join/short',
  'https://x.test/join/AbCdEfGh12?x=1', 'https://u:p@x.test/join/AbCdEfGh12',
  'https://x.test/channels/AbCdEfGh12', 'not a url', 'https://x.test/join/AbCdEfGh12#x',
  'https://X.test/join/AbCdEfGh12', ' https://x.test/join/AbCdEfGh12',
  'https://x.test/join/' + 'a'.repeat(257), 'https://' + 'x'.repeat(2048) + '/join/AbCdEfGh12',
])('rejects an invalid link: %s', link => expect(parseChannelLink(link)).toBeNull());
it('validates link before harness and label without fetching', async () => {
  const deps = fake();
  await rejects(requestJoin({ ...input, link: 'https://x.test/channels/AbCdEfGh12', harness: 'bad' as Harness, label: '' }, deps), 'invalid_link', 'invalid_link');
  await rejects(requestJoin({ ...input, harness: 'bad' as Harness, label: '' }, deps), 'internal_error', 'invalid_harness');
  expect(deps.calls).toHaveLength(0);
});
it.each(['', 'System', 'a'.repeat(41), 'a\u0007b'])('rejects invalid label %j without fetching', async label => {
  const deps = fake();
  await rejects(requestJoin({ ...input, label }, deps), 'internal_error', 'invalid_label');
  expect(deps.calls).toHaveLength(0);
});
it('requests once with Origin and a normalized label, returning only contract fields', async () => {
  const deps = fake(reply(201, { ...created, extra: 'ignored' }));
  expect(await requestJoin({ ...input, label: '  Claude  ' }, deps)).toEqual({ ...created, origin });
  expect(deps.calls).toEqual([{ url: `${origin}/api/agent/join`, method: 'POST',
    headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(input) }]);
});
const gatewayCases: [number, unknown, string][] = [
  [403, { code: 'forbidden_origin', requestId: 'r1' }, 'forbidden_origin'],
  [405, { code: 'method_not_allowed', requestId: 'r1' }, 'method_not_allowed'],
  [405, {}, 'method_not_allowed'],
  [413, { code: 'payload_too_large', requestId: 'r1' }, 'payload_too_large'],
  [503, { code: 'feature_unavailable', requestId: 'r1' }, 'feature_unavailable'],
  [503, { error: 'unavailable' }, 'unavailable'],
];
it.each([
  [400, { error: 'invalid_link' }, 'invalid_link', 'invalid_link'],
  [400, { error: 'invalid_label' }, 'internal_error', 'invalid_label'],
  [400, { error: 'invalid_harness' }, 'internal_error', 'invalid_harness'],
  [404, { error: 'link_unavailable' }, 'link_unavailable', 'link_unavailable'],
  [404, { code: 'not_found', requestId: 'r1' }, 'internal_error', 'route_not_found'],
  [429, {}, 'internal_error', 'rate_limited'], [500, {}, 'internal_error', 'protocol'],
  [400, { error: 'ps_9f syt_x r1' }, 'internal_error', 'protocol'],
  ...gatewayCases.map(([status, body, reason]) => [status, body, 'internal_error', reason] as [number, unknown, string, string]),
] satisfies [number, unknown, string, string][])('maps request status %s safely (%j)', async (status, body, code, reason) => {
  const deps = fake(reply(status, body));
  await rejects(requestJoin(input, deps), code, reason);
  expect(deps.calls).toHaveLength(1);
});
it('sanitizes network errors on both POSTs without retrying', async () => {
  const requestDeps = fake(new Error('ps_9f syt_x r1'));
  await rejects(requestJoin(input, requestDeps), 'internal_error', 'network');
  const readyDeps = fake(new Error('ps_9f syt_x r1'));
  await rejects(reportReady(session, readyDeps), 'internal_error', 'network');
  expect(requestDeps.calls).toHaveLength(1);
  expect(readyDeps.calls).toHaveLength(1);
});
it.each([
  { confirmUrl: 'https://other.test/agent/confirm?joinId=j_7Qx' },
  { confirmUrl: `${origin}/wrong` }, { confirmUrl: 'bad' }, { joinId: '' },
  { pollSecret: '' }, { expiresAt: 'bad' }, { expiresAt: 1 },
])('rejects malformed created bodies %j', async fields => {
  await rejects(requestJoin(input, fake(reply(201, { ...created, ...fields }))), 'internal_error', 'protocol');
});
it('rejects non-JSON responses safely', async () => {
  await rejects(requestJoin(input, fake(new Response('ps_9f syt_x', { status: 201 }))), 'internal_error', 'protocol');
});
it('polls pending twice then returns credentials once without consuming claimed', async () => {
  const deps = fake(reply(200, { state: 'pending' }), reply(200, { state: 'pending' }), reply(200, confirmed), reply(200, { state: 'claimed' }));
  expect(await pollJoin(session, deps)).toEqual(credentials);
  expect(deps.sleeps).toEqual([2000, 2000]);
  expect(deps.calls).toEqual(Array.from({ length: 3 }, () => ({ url: `${origin}/api/agent/join/poll?joinId=j_7Qx`,
    method: 'GET', headers: { authorization: 'Bearer ps_9f' }, body: undefined })));
});
it.each([
  [200, { state: 'claimed' }, 'claimed'], [200, { state: 'expired' }, 'expired'],
  [404, { error: 'not_found' }, 'not_found'], [404, { code: 'not_found', requestId: 'r1' }, 'not_found'],
])('maps terminal poll %s %j to join_expired', async (status, body, reason) => {
  await rejects(pollJoin(session, fake(reply(status, body))), 'join_expired', reason);
});
it('retries network, route/gateway 503 and 429 responses', async () => {
  const deps = fake(new Error('ps_9f'), reply(503, { error: 'unavailable' }), reply(503, { code: 'feature_unavailable' }), reply(429), reply(200, confirmed));
  expect(await pollJoin(session, deps)).toEqual(credentials);
  expect(deps.sleeps).toEqual([2000, 2000, 2000, 2000]);
});
it('expires after polls at 0, 2000 and 4000 within a 5000ms deadline', async () => {
  const deps = fake(...Array.from({ length: 3 }, () => reply(200, { state: 'pending' })));
  await rejects(pollJoin(session, { ...deps, timeoutMs: 5000 }), 'join_expired', 'timeout');
  expect(deps.calls).toHaveLength(3);
  expect(deps.sleeps).toEqual([2000, 2000]);
});
it('uses the default ten-minute deadline', async () => {
  const deps = fake(...Array.from({ length: 301 }, () => reply(200, { state: 'pending' })));
  await rejects(pollJoin(session, deps), 'join_expired', 'timeout');
  expect(deps.calls).toHaveLength(301);
  expect(deps.now()).toBe(600_000);
});
it('checks deadline again after a slow request', async () => {
  const deps = fake();
  await rejects(pollJoin(session, { ...deps, timeoutMs: 5000, fetch: async () => {
    deps.advance(5001); return reply(200, confirmed);
  } }), 'join_expired', 'timeout');
});
it.each([
  { state: 'confirmed', credentials: { ...credentials, accessToken: undefined } },
  { state: 'confirmed', credentials: { ...credentials, homeserver: 'bad' } },
  { state: 'unknown' }, {},
])('rejects malformed poll %j', async body => {
  await rejects(pollJoin(session, fake(reply(200, body))), 'internal_error', 'protocol');
});
it.each([400, 403, 405, 204])('rejects nonretryable poll status %s', async status => {
  await rejects(pollJoin(session, fake(reply(status))), 'internal_error', 'protocol');
});
it('aborts before fetching and during injected sleep', async () => {
  const controller = new AbortController();
  controller.abort('ps_9f');
  const deps = fake();
  await rejects(pollJoin(session, { ...deps, signal: controller.signal }), 'internal_error', 'network');
  expect(deps.calls).toHaveLength(0);
  const later = new AbortController();
  const pending = fake(reply(200, { state: 'pending' }));
  await rejects(pollJoin(session, { ...pending, signal: later.signal, sleep: async () => { later.abort(); } }), 'internal_error', 'network');
  expect(pending.calls).toHaveLength(1);
});
it('passes cancellation to fetch and stops on in-flight abort', async () => {
  const controller = new AbortController();
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    expect(init?.signal).toBeInstanceOf(AbortSignal); controller.abort();
    expect(init?.signal?.aborted).toBe(true); throw new Error('ps_9f');
  });
  await rejects(pollJoin(session, { fetch, signal: controller.signal }), 'internal_error', 'network');
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('cancels the default sleep and clears its timer', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const deps = fake(reply(200, { state: 'pending' }));
  const outcome = rejects(pollJoin(session, { fetch: deps.fetch, signal: controller.signal }), 'internal_error', 'network');
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(2);
  controller.abort();
  await outcome;
  expect(vi.getTimerCount()).toBe(0);
  expect(deps.calls).toHaveLength(1);
});
it('reports ready once with exact query, JSON body and Origin', async () => {
  const deps = fake(reply(204));
  await reportReady(session, deps);
  expect(deps.calls).toEqual([{ url: `${origin}/api/agent/join/ready?joinId=j_7Qx`, method: 'POST',
    headers: { authorization: 'Bearer ps_9f', 'content-type': 'application/json', origin }, body: '{}' }]);
});
it.each([
  [409, { error: 'not_confirmed' }, 'not_confirmed'],
  [404, { error: 'not_found' }, 'ready_not_found'],
  [404, { code: 'not_found', requestId: 'r1' }, 'ready_not_found'],
  [500, {}, 'protocol'], ...gatewayCases,
] satisfies [number, unknown, string][])('maps ready errors %s %j', async (status, body, reason) => {
  const deps = fake(reply(status, body));
  await rejects(reportReady(session, deps), 'internal_error', reason);
  expect(deps.calls).toHaveLength(1);
});
it('encodes joinId only as a query parameter for poll and ready', async () => {
  const deps = fake(reply(200, confirmed), reply(204));
  const encoded = { ...session, joinId: 'a/b c' };
  await pollJoin(encoded, deps); await reportReady(encoded, deps);
  expect(deps.calls.map(call => call.url)).toEqual([
    `${origin}/api/agent/join/poll?joinId=a%2Fb+c`, `${origin}/api/agent/join/ready?joinId=a%2Fb+c`,
  ]);
});

it('cancels unread transient response bodies before retrying', async () => {
  const response = reply(503, { error: 'unavailable' });
  const cancel = vi.spyOn(response.body!, 'cancel');
  const deps = fake(response, reply(200, confirmed));
  expect(await pollJoin(session, deps)).toEqual(credentials);
  expect(cancel).toHaveBeenCalledOnce();
});

it.each(['fetch', 'body'] as const)('enforces deadline even when %s never resolves', async stalled => {
  vi.useFakeTimers();
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    if (stalled === 'fetch') return new Promise<Response>(() => {});
    return new Response(new ReadableStream({ start() {} }));
  });
  const outcome = rejects(pollJoin(session, { fetch, timeoutMs: 5000 }), 'join_expired', 'timeout');
  await vi.advanceTimersByTimeAsync(5000);
  await outcome;
  expect(fetch).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it('caller abort interrupts a stalled body read', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const fetch: typeof globalThis.fetch = async () => new Response(new ReadableStream({ start() {} }));
  const outcome = rejects(pollJoin(session, { fetch, signal: controller.signal }), 'internal_error', 'network');
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  await outcome;
  expect(vi.getTimerCount()).toBe(0);
});
