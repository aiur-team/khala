import { describe, expect, it, vi } from 'vitest';
import type { AuthPrincipal, OwnerId, StableAgentPrincipal } from '@khala/contracts/messaging/index';
import type { MutationAuthorization } from '../auth/index';
import { T0, fakeStore, secureRandom } from '../auth/support.test';
import type { DiscoveryCredentials } from './bootstrap/handler';
import {
  CRAWL_WINDOW_MS,
  MAX_ACCOUNT_RATE_LIMITED_PER_WINDOW,
  MAX_ACCOUNT_REQUESTS_PER_WINDOW,
  type OperatorAlert,
  createCrawlDetector,
  createWebhookAlertSink,
  effectiveThresholds,
} from './crawl';
import { runRolloutDrill } from './drill';
import { LIST_PATH, ROLLOUT_PATH, SETTINGS_PATH, createChannelDiscoveryHandlers } from './handler';
import { LIST_REQUESTS_PER_WINDOW, LIST_WINDOW_MS } from './listing';
import { DRILL_VALIDITY_MS, type DrillReport, KILL_SWITCH_DEADLINE_MS, ROLLOUT_KEY, createRolloutControl } from './rollout';
import type { DiscoveryTelemetryEvent } from './telemetry';

const ORIGIN = 'https://khala.aiur.team';
const JKT = 'j'.repeat(43);
const PASSING: DrillReport = {
  v: 1, completedAt: '2026-09-17T12:00:00.000Z', killSwitchPropagationMs: 0,
  checks: { pageCap: true, limiter: true, alert: true, killSwitch: true, privateRetained: true },
};

function principal(ownerId: string): AuthPrincipal {
  return {
    v: 1, ownerId: ownerId as OwnerId, providerIssuer: 'https://id.example.test', providerSubject: `sub-${ownerId}`,
    verifiedEmail: `${ownerId}@example.test`, sessionExpiresAt: '2026-09-18T20:00:00Z',
  };
}

type Options = { alertFailures?: number; thresholds?: { requests?: number; rateLimited?: number } };

/** The hosted composition: store-backed rollout, telemetry, crawl detection and operator alerts. */
function setup(options: Options = {}) {
  let now = T0;
  const clock = () => now;
  const store = fakeStore(clock);
  const callers = new Map<string, { ownerId: string; principal: string; generation: number }>();
  const owners = new Map<string, string>([['!pub_a', 'owner_a'], ['!priv_b', 'owner_b'], ['!priv_a', 'owner_a']]);
  const events: DiscoveryTelemetryEvent[] = [];
  const alerts: OperatorAlert[] = [];
  let alertFailures = options.alertFailures ?? 0;
  const telemetry = { record: (event: DiscoveryTelemetryEvent) => { events.push(event); } };
  const credentials: DiscoveryCredentials = {
    async authorize(request) {
      const token = /^DPoP (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
      const caller = token ? callers.get(token) : undefined;
      if (!caller) return { kind: 'refused', status: 401, code: 'invalid_credential' };
      return {
        kind: 'authorized', action: 'list_channels', ownerId: caller.ownerId as OwnerId,
        requester: {
          principal: caller.principal as StableAgentPrincipal, origin: ORIGIN, sessionGeneration: caller.generation,
          proofKey: { algorithm: 'Ed25519', publicKey: 'k'.repeat(43), thumbprint: JKT },
        },
      };
    },
  };
  const crawl = createCrawlDetector({
    store: store.store, clock, random: secureRandom, telemetry, thresholds: options.thresholds ?? {},
    alerts: {
      async deliver(alert) {
        if (alertFailures > 0) {
          alertFailures -= 1;
          return 'failed';
        }
        alerts.push(alert);
        return 'delivered';
      },
    },
  });
  const handlers = createChannelDiscoveryHandlers({
    store: store.store, clock, random: secureRandom, credentials, telemetry, crawl,
    publicDiscovery: createRolloutControl({ store: store.store }),
    operators: { isOperator: async ({ ownerId }) => (ownerId === 'operator' ? 'operator' : 'forbidden') },
    async authorizeMutation(request): Promise<MutationAuthorization> {
      const owner = request.headers.get('x-owner');
      return owner ? { kind: 'authorized', context: { principal: principal(owner), csrfToken: 'csrf' } } : { kind: 'rejected', code: 'signed_out' };
    },
    ownerAuthority: { canManage: async ({ ownerId, roomId }) => (owners.get(roomId) === ownerId ? 'allowed' : 'forbidden') },
    principals: { inspect: async () => ({ kind: 'unknown' }) },
  });
  const route = (path: string) => [...handlers.agent, ...handlers.human].find(item => item.path === path)!;
  let operation = 0;
  let rolloutRevision: string | null = null;
  const revisions = new Map<string, string | null>();

  function list(token: string, query = '') {
    return route(LIST_PATH).handle(new Request(`${ORIGIN}${LIST_PATH}${query}`, { headers: { authorization: `DPoP ${token}` } }));
  }
  async function page(token: string, query = '') {
    const response = await list(token, query);
    expect(response.status).toBe(200);
    return await response.json() as { items: Array<{ title: string; visibility: string; listingRef: string }>; nextCursor: string | null };
  }
  function put(path: string, owner: string, body: Record<string, unknown>) {
    return route(path).handle(new Request(`${ORIGIN}${path}`, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-owner': owner }, body: JSON.stringify(body),
    }));
  }
  async function settings(owner: string, roomId: string, visibility: string, title: string | null) {
    const response = await put(SETTINGS_PATH, owner, {
      v: 1, operationId: `op-${operation++}`, roomId, visibility, title, expectedRevision: revisions.get(roomId) ?? null,
    });
    if (response.status === 200) revisions.set(roomId, (await response.clone().json() as { revision: string }).revision);
    return response;
  }
  async function rollout(action: string, extra: { drill?: unknown; operator?: string; expectedRevision?: string | null } = {}) {
    const response = await put(ROLLOUT_PATH, extra.operator ?? 'operator', {
      v: 1, action, operationId: `rollout-${operation++}`, expectedRevision: extra.expectedRevision === undefined ? rolloutRevision : extra.expectedRevision,
      drill: extra.drill ?? null,
    });
    if (response.status === 200) rolloutRevision = (await response.clone().json() as { revision: string }).revision;
    return response;
  }
  /** Drill, enable, and publish one public and two private channels. */
  async function launched() {
    expect((await rollout('record_drill', { drill: PASSING })).status).toBe(200);
    expect((await rollout('enable')).status).toBe(200);
    expect((await settings('owner_a', '!pub_a', 'public', 'Alpha public')).status).toBe(200);
    expect((await settings('owner_b', '!priv_b', 'private', 'Beta private')).status).toBe(200);
  }
  function session(token: string, ownerId = 'owner_b', agent = token, generation = 1) {
    callers.set(token, { ownerId, principal: agent, generation });
    return token;
  }
  return {
    store, handlers, events, alerts, list, page, settings, rollout, launched, session,
    advance(ms: number) { now += ms; },
    now: clock,
  };
}

const titles = (page: { items: Array<{ title: string }> }) => page.items.map(item => item.title);

describe('hosted rollout state', () => {
  it('keeps public discovery disabled by default while private discovery and owner settings work', async () => {
    const h = setup();
    const b = h.session('b');
    const refused = await h.settings('owner_a', '!pub_a', 'public', 'Alpha public');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ v: 1, kind: 'rejected', code: 'public_discovery_disabled' });
    expect((await h.settings('owner_b', '!priv_b', 'private', 'Beta private')).status).toBe(200);
    expect(titles(await h.page(b))).toEqual(['Beta private']);
    expect(h.store.records.has(ROLLOUT_KEY)).toBe(false);
    expect(h.events.at(-1)).toMatchObject({ event: 'channel_discovery.list', publicDiscovery: 'disabled', result: 'ok' });
  });

  it('refuses to enable until an operator records a passing drill, and only for operators', async () => {
    const h = setup();
    const noDrill = await h.rollout('enable');
    expect(noDrill.status).toBe(409);
    expect(await noDrill.json()).toEqual({ v: 1, kind: 'rejected', code: 'drill_required' });

    const failing = { ...PASSING, checks: { ...PASSING.checks, alert: false } };
    expect(await (await h.rollout('record_drill', { drill: failing })).json()).toEqual({ v: 1, kind: 'rejected', code: 'drill_failed' });
    const slow = { ...PASSING, killSwitchPropagationMs: KILL_SWITCH_DEADLINE_MS };
    expect((await h.rollout('record_drill', { drill: slow })).status).toBe(400);
    expect((await h.rollout('record_drill', { drill: { ...PASSING, extra: true } })).status).toBe(400);
    expect((await h.rollout('record_drill', { drill: PASSING, operator: 'owner_a' })).status).toBe(403);
    expect((await h.rollout('enable', { operator: 'owner_a' })).status).toBe(403);

    expect((await h.rollout('record_drill', { drill: PASSING })).status).toBe(200);
    expect((await h.rollout('enable', { expectedRevision: null })).status).toBe(409);
    expect((await h.rollout('enable')).status).toBe(200);
    expect((await h.settings('owner_a', '!pub_a', 'public', 'Alpha public')).status).toBe(200);
    expect(titles(await h.page(h.session('b')))).toEqual(['Alpha public']);
  });

  it('requires a fresh drill for every later enable', async () => {
    const h = setup();
    await h.rollout('record_drill', { drill: PASSING });
    await h.rollout('enable');
    await h.rollout('disable');
    h.advance(DRILL_VALIDITY_MS);
    expect(await (await h.rollout('enable')).json()).toEqual({ v: 1, kind: 'rejected', code: 'drill_required' });
  });

  it('reconciles a retried rollout operation and refuses its reuse for another action', async () => {
    const h = setup();
    await h.rollout('record_drill', { drill: PASSING });
    const body = { v: 1, action: 'engage_kill_switch', operationId: 'kill-1', expectedRevision: (await readRevision(h)), drill: null };
    const route = h.handlers.human.find(item => item.path === ROLLOUT_PATH)!;
    const send = (value: Record<string, unknown>) => route.handle(new Request(`${ORIGIN}${ROLLOUT_PATH}`, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-owner': 'operator' }, body: JSON.stringify(value),
    }));
    const first = await (await send(body)).json();
    expect(await (await send(body)).json()).toEqual(first);
    expect((await send({ ...body, action: 'release_kill_switch' })).status).toBe(409);
  });

  it('fails closed for public listing when the rollout record is unreadable', async () => {
    const h = setup();
    await h.launched();
    const b = h.session('b');
    h.store.inject('read', 'unavailable');
    expect(titles(await h.page(b))).toEqual(['Beta private']);
  });
});

describe('public-discovery kill switch', () => {
  it('returns no public results while private eligible results stay projected', async () => {
    const h = setup();
    await h.launched();
    const b = h.session('b');
    expect(titles(await h.page(b))).toEqual(['Alpha public', 'Beta private']);

    expect((await h.rollout('engage_kill_switch')).status).toBe(200);
    // Wrong-implementation test: a valid public-list request under the kill switch.
    const killed = await h.page(b);
    expect(killed.items).toEqual([expect.objectContaining({ title: 'Beta private', visibility: 'private', serviceKind: 'external' })]);
    expect(h.events.at(-1)).toMatchObject({ publicDiscovery: 'killed', publicItems: 0, items: 1 });

    expect((await h.rollout('release_kill_switch')).status).toBe(200);
    expect(titles(await h.page(b))).toEqual(['Alpha public', 'Beta private']);
  });

  it('takes effect on the next request, invalidating earlier cursors and listing references', async () => {
    const h = setup();
    await h.launched();
    const b = h.session('b');
    const before = await h.list(b, '?limit=1');
    const first = await before.json() as { items: Array<{ listingRef: string }>; nextCursor: string };
    const ref = first.items[0]!.listingRef;
    const caller = { ownerId: 'owner_b' as OwnerId, requester: {
      principal: 'b' as StableAgentPrincipal, origin: ORIGIN, sessionGeneration: 1,
      proofKey: { algorithm: 'Ed25519' as const, publicKey: 'k'.repeat(43), thumbprint: JKT },
    } };
    expect((await h.handlers.resolveListingRef(caller, ref)).kind).toBe('resolved');

    const engagedAt = h.now();
    await h.rollout('engage_kill_switch');
    const next = await h.list(b, `?cursor=${first.nextCursor}`);
    expect(next.status).toBe(410);
    expect(await h.handlers.resolveListingRef(caller, ref)).toEqual({ kind: 'unavailable' });
    expect(h.now() - engagedAt).toBeLessThan(KILL_SWITCH_DEADLINE_MS);
  });

  it('leaves owner settings available: public owners can still retitle or narrow visibility', async () => {
    const h = setup();
    await h.launched();
    await h.rollout('engage_kill_switch');
    expect((await h.settings('owner_a', '!pub_a', 'public', 'Alpha renamed')).status).toBe(200);
    expect((await h.settings('owner_a', '!priv_a', 'private', 'Alpha private')).status).toBe(200);
    expect(titles(await h.page(h.session('a', 'owner_a')))).toEqual(['Alpha private']);
    await h.rollout('release_kill_switch');
    expect(titles(await h.page(h.session('a2', 'owner_a')))).toEqual(['Alpha private', 'Alpha renamed']);
  });
});

describe('crawl telemetry and detection', () => {
  it('emits only digests, result codes and counts', async () => {
    const h = setup();
    await h.launched();
    const b = h.session('b', 'owner_b', 'agent_secret_principal', 7);
    const first = await h.page(b, '?limit=1');
    await h.list(b, `?cursor=${first.nextCursor}`);
    for (let i = 0; i < LIST_REQUESTS_PER_WINDOW; i += 1) await h.list(b);
    await h.rollout('engage_kill_switch');

    const serialized = JSON.stringify(h.events);
    for (const forbidden of ['Alpha', 'Beta', 'dlr_', 'dcs_', '!pub_a', '!priv_b', 'owner_b', 'agent_secret_principal', ':"operator"', ORIGIN, JKT]) {
      expect(serialized).not.toContain(forbidden);
    }
    const listEvent = h.events.find(event => event.event === 'channel_discovery.list')!;
    expect(Object.keys(listEvent).sort()).toEqual(['account', 'at', 'event', 'items', 'page', 'publicDiscovery', 'publicItems', 'result', 'session', 'v']);
    expect(h.events.filter(event => event.event === 'channel_discovery.list').map(event => 'page' in event && event.page).slice(0, 2)).toEqual(['first', 'next']);
    expect(h.events.some(event => event.event === 'channel_discovery.list' && event.result === 'rate_limited')).toBe(true);
    expect(h.events.at(-1)).toMatchObject({ event: 'channel_discovery.rollout', action: 'engage_kill_switch', result: 'applied' });
  });

  it('holds the exact per-session limiter boundary under a scripted per-account crawl', async () => {
    const h = setup();
    await h.launched();
    const sessions = ['s1', 's2', 's3'].map(token => h.session(token));
    for (const token of sessions) {
      for (let i = 0; i < LIST_REQUESTS_PER_WINDOW; i += 1) {
        const page = await h.page(token);
        expect(page.items.length).toBeLessThanOrEqual(25);
      }
      expect((await h.list(token)).status).toBe(429);
    }
    h.advance(LIST_WINDOW_MS);
    expect((await h.list(sessions[0]!)).status).toBe(200);
  });

  it('alerts the operator once per account and window when rate-limited crawling crosses the threshold', async () => {
    const h = setup();
    await h.launched();
    const s1 = h.session('s1');
    const other = h.session('other', 'owner_a');
    for (let i = 0; i < LIST_REQUESTS_PER_WINDOW + MAX_ACCOUNT_RATE_LIMITED_PER_WINDOW - 1; i += 1) await h.list(s1);
    for (let i = 0; i < 3; i += 1) await h.list(other);
    expect(h.alerts).toEqual([]);

    expect((await h.list(s1)).status).toBe(429);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toMatchObject({ kind: 'channel_discovery.crawl_suspected', rateLimited: MAX_ACCOUNT_RATE_LIMITED_PER_WINDOW });
    expect(JSON.stringify(h.alerts)).not.toContain('owner_b');
    await h.list(s1);
    expect(h.alerts).toHaveLength(1);
    expect(h.events.filter(event => event.event === 'channel_discovery.crawl_suspected')).toHaveLength(1);

    h.advance(CRAWL_WINDOW_MS);
    for (let i = 0; i < LIST_REQUESTS_PER_WINDOW + MAX_ACCOUNT_RATE_LIMITED_PER_WINDOW; i += 1) await h.list(s1);
    expect(h.alerts).toHaveLength(2);
    expect(h.alerts[1]!.alertId).not.toBe(h.alerts[0]!.alertId);
  });

  it('alerts on account-wide volume spread across sessions that each stay under the limiter', async () => {
    const h = setup({ thresholds: { requests: 20 } });
    await h.launched();
    const sessions = ['s1', 's2', 's3'].map(token => h.session(token));
    for (const token of sessions.slice(0, 2)) for (let i = 0; i < LIST_REQUESTS_PER_WINDOW; i += 1) await h.list(token);
    expect(h.alerts).toEqual([]);
    expect((await h.list(sessions[2]!)).status).toBe(200);
    expect(h.alerts).toEqual([expect.objectContaining({ requests: 21, rateLimited: 0 })]);
  });

  it('retries a failed alert delivery on the next request', async () => {
    const h = setup({ alertFailures: 1, thresholds: { requests: 2 } });
    await h.launched();
    const s1 = h.session('s1');
    for (let i = 0; i < 3; i += 1) await h.list(s1);
    expect(h.alerts).toEqual([]);
    expect(h.events.at(-1)).toMatchObject({ event: 'channel_discovery.crawl_suspected', alert: 'failed' });
    await h.list(s1);
    expect(h.alerts).toHaveLength(1);
  });

  it('accepts only lower operator thresholds', () => {
    expect(effectiveThresholds({ requests: 1_000, rateLimited: 50 })).toEqual({
      requests: MAX_ACCOUNT_REQUESTS_PER_WINDOW, rateLimited: MAX_ACCOUNT_RATE_LIMITED_PER_WINDOW,
    });
    expect(effectiveThresholds({ requests: 30, rateLimited: 2 })).toEqual({ requests: 30, rateLimited: 2 });
    expect(effectiveThresholds({ requests: 0, rateLimited: 1.5 })).toEqual({
      requests: MAX_ACCOUNT_REQUESTS_PER_WINDOW, rateLimited: MAX_ACCOUNT_RATE_LIMITED_PER_WINDOW,
    });
  });
});

describe('operator alert webhook', () => {
  const alert: OperatorAlert = {
    v: 1, kind: 'channel_discovery.crawl_suspected', alertId: 'a', account: 'b', windowStart: '2026-09-17T12:00:00.000Z',
    requests: 1, rateLimited: 5, publicItems: 3,
  };

  it('posts the fixed alert shape without following redirects', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const sink = createWebhookAlertSink({ url: 'https://alerts.example.test/hook', fetch });
    expect(await sink.deliver(alert)).toBe('delivered');
    const [, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(JSON.parse(init.body as string)).toEqual(alert);

    fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://elsewhere.example' } }));
    expect(await sink.deliver(alert)).toBe('failed');
    fetch.mockRejectedValueOnce(new Error('down'));
    expect(await sink.deliver(alert)).toBe('failed');
  });

  it('refuses non-HTTPS and credentialed endpoints', () => {
    expect(() => createWebhookAlertSink({ url: 'http://alerts.example.test/hook' })).toThrow();
    expect(() => createWebhookAlertSink({ url: 'https://user:pass@alerts.example.test/hook' })).toThrow();
    expect(() => createWebhookAlertSink({ url: 'http://127.0.0.1:9000/hook' })).not.toThrow();
  });
});

describe('operations drill', () => {
  function target(h: ReturnType<typeof setup>, options: { killSwitchWorks?: boolean } = {}) {
    let kill = 0;
    return {
      now: h.now,
      sleep: async (ms: number) => { h.advance(ms); },
      list: (token: string) => h.list(token),
      sessions: ['c1', 'c2', 'probe'].map(token => h.session(token)),
      async setKillSwitch(engaged: boolean) {
        if (options.killSwitchWorks === false) return;
        expect((await h.rollout(engaged ? 'engage_kill_switch' : 'release_kill_switch')).status).toBe(200);
        kill += 1;
      },
      alerts: async () => h.alerts,
      kills: () => kill,
    };
  }

  /** Staging: public discovery enabled for the drill against a staging catalog. */
  async function staging() {
    const h = setup();
    await h.launched();
    return h;
  }

  it('proves limits, alert delivery and kill-switch propagation, and its report enables production', async () => {
    const h = await staging();
    const drill = target(h);
    const report = await runRolloutDrill(drill);
    expect(report.checks).toEqual({ pageCap: true, limiter: true, alert: true, killSwitch: true, privateRetained: true });
    expect(report.killSwitchPropagationMs).toBeLessThan(KILL_SWITCH_DEADLINE_MS);
    expect(drill.kills()).toBe(2);

    const production = setup();
    expect((await production.rollout('record_drill', { drill: report })).status).toBe(200);
    expect((await production.rollout('enable')).status).toBe(200);
  });

  it('fails when the kill switch never removes public results, and that report cannot enable', async () => {
    const h = await staging();
    const report = await runRolloutDrill(target(h, { killSwitchWorks: false }));
    expect(report.checks.killSwitch).toBe(false);
    expect(report.killSwitchPropagationMs).toBe(KILL_SWITCH_DEADLINE_MS);
    const production = setup();
    expect((await production.rollout('record_drill', { drill: report })).status).toBe(400);
    expect((await production.rollout('enable')).status).toBe(409);
  });
});

async function readRevision(h: ReturnType<typeof setup>): Promise<string | null> {
  return h.store.records.get(ROLLOUT_KEY)?.revision ?? null;
}
