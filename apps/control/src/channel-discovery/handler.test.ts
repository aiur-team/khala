import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthPrincipal, OwnerId, StableAgentPrincipal } from '@khala/contracts/messaging/index';
import type { MutationAuthorization } from '../auth/index';
import { T0, fakeStore, secureRandom } from '../auth/support.test';
import type { DiscoveryCredentials } from './bootstrap/handler';
import { CATALOG_KEY } from './catalog';
import { ALLOWLIST_PATH, LIST_PATH, SETTINGS_PATH, createChannelDiscoveryHandlers } from './handler';
import { LIST_REQUESTS_PER_WINDOW, LIST_WINDOW_MS, SNAPSHOT_TTL_MS } from './listing';

const ORIGIN = 'https://khala.aiur.team';
const JKT = 'j'.repeat(43);

type Caller = { ownerId: string; principal: string; generation: number; jkt?: string };

function principal(ownerId: string): AuthPrincipal {
  return {
    v: 1, ownerId: ownerId as OwnerId, providerIssuer: 'https://id.example.test', providerSubject: `sub-${ownerId}`,
    verifiedEmail: `${ownerId}@example.test`, sessionExpiresAt: '2026-09-18T20:00:00Z',
  };
}

/** Deterministic byte source so two datasets can be compared byte for byte. */
function countingRandom() {
  let next = 0;
  return (bytes: number) => Uint8Array.from({ length: bytes }, () => (next++ * 37 + 11) & 255);
}

function setup(options: { publicDiscovery?: 'enabled' | 'disabled'; random?: (bytes: number) => Uint8Array } = {}) {
  let now = T0;
  const clock = () => now;
  const store = fakeStore(clock);
  const callers = new Map<string, Caller>();
  const owners = new Map<string, string>();
  const known = new Map<string, { agentOwnerId: string; currentGeneration: number }>();
  const revisions = new Map<string, string | null>();
  let credentialsDown = false;
  const credentials: DiscoveryCredentials = {
    async authorize(request) {
      if (credentialsDown) return { kind: 'unavailable' };
      const token = /^DPoP (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
      if (!token) return { kind: 'refused', status: 401, code: 'credential_required' };
      const caller = callers.get(token);
      if (!caller) return { kind: 'refused', status: 401, code: 'invalid_credential' };
      return {
        kind: 'authorized', action: 'list_channels', ownerId: caller.ownerId as OwnerId,
        requester: {
          principal: caller.principal as StableAgentPrincipal, origin: ORIGIN, sessionGeneration: caller.generation,
          proofKey: { algorithm: 'Ed25519', publicKey: 'k'.repeat(43), thumbprint: caller.jkt ?? JKT },
        },
      };
    },
  };
  const handlers = createChannelDiscoveryHandlers({
    store: store.store, clock, random: options.random ?? secureRandom, credentials,
    publicDiscovery: options.publicDiscovery ?? 'enabled',
    async authorizeMutation(request): Promise<MutationAuthorization> {
      const owner = request.headers.get('x-owner');
      return owner ? { kind: 'authorized', context: { principal: principal(owner), csrfToken: 'csrf' } } : { kind: 'rejected', code: 'signed_out' };
    },
    ownerAuthority: {
      async canManage({ ownerId, roomId }) {
        return owners.get(roomId) === ownerId ? 'allowed' : 'forbidden';
      },
    },
    principals: {
      async inspect({ ownerId, principal: agent }) {
        const found = known.get(`${ownerId}:${agent}`);
        return found ? { kind: 'known', agentOwnerId: found.agentOwnerId as OwnerId, currentGeneration: found.currentGeneration } : { kind: 'unknown' };
      },
    },
  });
  const route = (path: string) => [...handlers.agent, ...handlers.human].find(item => item.path === path)!;
  let operation = 0;

  async function list(token: string | null, query = '') {
    const headers: Record<string, string> = token ? { authorization: `DPoP ${token}` } : {};
    return route(LIST_PATH).handle(new Request(`${ORIGIN}${LIST_PATH}${query}`, { headers }));
  }
  async function page(token: string, query = '') {
    const response = await list(token, query);
    expect(response.status).toBe(200);
    return await response.json() as { v: 1; items: Array<Record<string, string>>; nextCursor: string | null };
  }
  async function titles(token: string) {
    return (await page(token)).items.map(item => item.title);
  }
  function mutate(path: string, method: string, owner: string | null, body: Record<string, unknown>) {
    return route(path).handle(new Request(`${ORIGIN}${path}`, {
      method, headers: { 'content-type': 'application/json', ...(owner ? { 'x-owner': owner } : {}) }, body: JSON.stringify(body),
    }));
  }
  async function settings(owner: string, roomId: string, visibility: string, title: string | null, extra: Record<string, unknown> = {}) {
    const response = await mutate(SETTINGS_PATH, 'PUT', owner, {
      v: 1, operationId: `op-${operation++}`, roomId, visibility, title, expectedRevision: revisions.get(roomId) ?? null, ...extra,
    });
    if (response.status === 200) revisions.set(roomId, (await response.clone().json() as { revision: string }).revision);
    return response;
  }
  async function allowlist(owner: string, action: 'allow' | 'revoke', roomId: string, agent: string, generation: number, extra: Record<string, unknown> = {}) {
    const response = await mutate(ALLOWLIST_PATH, 'POST', owner, {
      v: 1, action, operationId: `op-${operation++}`, roomId, principal: agent, expectedSessionGeneration: generation,
      expectedRevision: revisions.get(roomId) ?? '1', ...extra,
    });
    if (response.status === 200) revisions.set(roomId, (await response.clone().json() as { revision: string }).revision);
    return response;
  }
  function channel(roomId: string, owner: string) {
    owners.set(roomId, owner);
  }
  return {
    store, handlers, callers, owners, known, revisions, list, page, titles, mutate, settings, allowlist, channel,
    advance(ms: number) { now += ms; },
    credentialsDown(value: boolean) { credentialsDown = value; },
  };
}

function withAgents(h: ReturnType<typeof setup>) {
  h.callers.set('a1', { ownerId: 'owner_a', principal: 'agent_a', generation: 1 });
  h.callers.set('b1', { ownerId: 'owner_b', principal: 'agent_b', generation: 4 });
  h.callers.set('b2', { ownerId: 'owner_b', principal: 'agent_b2', generation: 1 });
  for (const [room, owner] of [['!pub_a', 'owner_a'], ['!priv_a', 'owner_a'], ['!secret_a', 'owner_a'], ['!absent_a', 'owner_a'], ['!priv_b', 'owner_b']]) {
    h.channel(room!, owner!);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('external channel discovery visibility', () => {
  it('lists public and same-owner private channels only, across two owners and two sessions', async () => {
    const h = setup();
    withAgents(h);
    expect((await h.settings('owner_a', '!pub_a', 'public', 'Alpha public')).status).toBe(200);
    expect((await h.settings('owner_a', '!priv_a', 'private', 'Alpha private')).status).toBe(200);
    expect((await h.settings('owner_a', '!secret_a', 'secret', null)).status).toBe(200);
    expect((await h.settings('owner_b', '!priv_b', 'private', 'Beta private')).status).toBe(200);

    expect(await h.titles('a1')).toEqual(['Alpha private', 'Alpha public']);
    expect(await h.titles('b1')).toEqual(['Alpha public', 'Beta private']);
    expect(await h.titles('b2')).toEqual(['Alpha public', 'Beta private']);
    const all = JSON.stringify([await h.page('a1'), await h.page('b1')]);
    expect(all).not.toContain('secret_a');
    expect(all).not.toContain('absent_a');
  });

  it('keeps hosted public discovery disabled', async () => {
    const h = setup({ publicDiscovery: 'disabled' });
    withAgents(h);
    const refused = await h.settings('owner_a', '!pub_a', 'public', 'Alpha public');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ v: 1, kind: 'rejected', code: 'public_discovery_disabled' });
    expect(h.store.records.has(CATALOG_KEY)).toBe(false);
    await h.settings('owner_a', '!priv_a', 'private', 'Alpha private');
    expect(await h.titles('a1')).toEqual(['Alpha private']);
    expect(await h.titles('b1')).toEqual([]);
  });

  it('registers lazily and tombstones on secret without reusing revisions', async () => {
    const h = setup();
    withAgents(h);
    expect(h.store.records.has(CATALOG_KEY)).toBe(false);
    expect(await h.titles('a1')).toEqual([]);

    await h.settings('owner_a', '!pub_a', 'public', 'Alpha public');
    expect(await h.titles('b1')).toEqual(['Alpha public']);
    expect(h.revisions.get('!pub_a')).toBe('1');

    await h.settings('owner_a', '!pub_a', 'secret', null);
    expect(await h.titles('b1')).toEqual([]);
    expect(await h.titles('a1')).toEqual([]);
    const tombstone = Object.values((h.store.records.get(CATALOG_KEY)!.value as { entries: Record<string, Record<string, unknown>> }).entries)[0]!;
    expect(tombstone).toMatchObject({ visibility: 'secret', title: null, revision: 2 });

    const stale = await h.settings('owner_a', '!pub_a', 'public', 'Again', { expectedRevision: null });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ v: 1, kind: 'rejected', code: 'stale_revision' });
  });

  it('allows only the current channel owner to mutate, and reconciles retries by operation', async () => {
    const h = setup();
    withAgents(h);
    const forbidden = await h.settings('owner_b', '!pub_a', 'public', 'Hijack');
    expect(forbidden.status).toBe(403);
    expect((await h.mutate(SETTINGS_PATH, 'PUT', null, {
      v: 1, operationId: 'x', roomId: '!pub_a', visibility: 'public', title: 'x', expectedRevision: null,
    })).status).toBe(401);
    expect(h.store.records.has(CATALOG_KEY)).toBe(false);

    const body = { v: 1, operationId: 'same-op', roomId: '!pub_a', visibility: 'public', title: 'Alpha', expectedRevision: null };
    const first = await h.mutate(SETTINGS_PATH, 'PUT', 'owner_a', body);
    const retry = await h.mutate(SETTINGS_PATH, 'PUT', 'owner_a', body);
    expect(await first.json()).toEqual({ v: 1, kind: 'applied', revision: '1' });
    expect(await retry.json()).toEqual({ v: 1, kind: 'applied', revision: '1' });
    const reused = await h.mutate(SETTINGS_PATH, 'PUT', 'owner_a', { ...body, title: 'Different' });
    expect(reused.status).toBe(409);
    expect(await reused.json()).toEqual({ v: 1, kind: 'rejected', code: 'operation_mismatch' });

    h.owners.set('!pub_a', 'owner_c');
    expect((await h.settings('owner_a', '!pub_a', 'secret', null, { expectedRevision: '1' })).status).toBe(403);
  });

  it('rejects malformed settings, including oversized titles, and normalizes control characters', async () => {
    const h = setup();
    withAgents(h);
    expect((await h.settings('owner_a', '!pub_a', 'public', 'x'.repeat(257))).status).toBe(400);
    expect((await h.settings('owner_a', '!pub_a', 'public', null)).status).toBe(400);
    expect((await h.settings('owner_a', '!pub_a', 'secret', 'titled secret')).status).toBe(400);
    expect((await h.settings('owner_a', '!pub_a', 'public', 'Alpha', { roomId: undefined })).status).toBe(400);
    expect((await h.mutate(SETTINGS_PATH, 'PUT', 'owner_a', {
      v: 1, operationId: 'x', roomId: '!pub_a', visibility: 'public', title: 'x', expectedRevision: null, ownerId: 'owner_a',
    })).status).toBe(400);
    await h.settings('owner_a', '!pub_a', 'public', 'Alpha\u001b[31m‮');
    expect(await h.titles('b1')).toEqual(['Alpha�[31m�']);
  });
});

describe('private stable-principal allowlist', () => {
  it('adds and revokes a known principal without trusting cross-owner principal collisions', async () => {
    const h = setup();
    withAgents(h);
    h.callers.set('c1', { ownerId: 'owner_c', principal: 'agent_b', generation: 4 });
    h.known.set('owner_a:agent_b', { agentOwnerId: 'owner_b', currentGeneration: 4 });
    await h.settings('owner_a', '!priv_a', 'private', 'Alpha private');
    expect(await h.titles('b1')).toEqual([]);

    expect((await h.allowlist('owner_a', 'allow', '!priv_a', 'agent_b', 4)).status).toBe(200);
    expect(await h.titles('b1')).toEqual(['Alpha private']);
    expect(await h.titles('b2')).toEqual([]);
    expect(await h.titles('c1')).toEqual([]);

    expect((await h.allowlist('owner_a', 'revoke', '!priv_a', 'agent_b', 4)).status).toBe(200);
    expect(await h.titles('b1')).toEqual([]);
  });

  it('requires the inspected generation, a known principal, and channel ownership', async () => {
    const h = setup();
    withAgents(h);
    h.known.set('owner_a:agent_b', { agentOwnerId: 'owner_b', currentGeneration: 5 });
    await h.settings('owner_a', '!priv_a', 'private', 'Alpha private');
    const stale = await h.allowlist('owner_a', 'allow', '!priv_a', 'agent_b', 4);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ v: 1, kind: 'rejected', code: 'stale_revision' });
    expect((await h.allowlist('owner_a', 'allow', '!priv_a', 'agent_unknown', 1)).status).toBe(403);
    h.known.set('owner_b:agent_b', { agentOwnerId: 'owner_b', currentGeneration: 5 });
    expect((await h.allowlist('owner_b', 'allow', '!priv_a', 'agent_b', 5)).status).toBe(403);
    expect((await h.allowlist('owner_a', 'allow', '!absent_a', 'agent_b', 5)).status).toBe(409);
  });

  it('keeps the stable allowlist across rebind while old-generation credentials stop working', async () => {
    const h = setup();
    withAgents(h);
    h.known.set('owner_a:agent_b', { agentOwnerId: 'owner_b', currentGeneration: 4 });
    await h.settings('owner_a', '!priv_a', 'private', 'Alpha private');
    await h.allowlist('owner_a', 'allow', '!priv_a', 'agent_b', 4);

    // Rebind: the bootstrap credential for generation 4 is refused; a new generation-5 credential is issued.
    h.callers.delete('b1');
    h.callers.set('b1-gen5', { ownerId: 'owner_b', principal: 'agent_b', generation: 5 });
    expect((await h.list('b1')).status).toBe(401);
    expect(await h.titles('b1-gen5')).toEqual(['Alpha private']);

    // Owner removal of the agent's owner: every credential is refused.
    h.callers.delete('b1-gen5');
    expect((await h.list('b1-gen5')).status).toBe(401);
  });
});

describe('discovery credential and transport', () => {
  it('passes credential refusals through without redirects and fails closed when unavailable', async () => {
    const h = setup();
    withAgents(h);
    const missing = await h.list(null);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: 'credential_required' });
    expect((await h.list('forged')).status).toBe(401);
    h.credentialsDown(true);
    expect((await h.list('a1')).status).toBe(503);
    for (const response of [missing]) expect(response.headers.get('location')).toBeNull();
  });

  it('rejects unknown query parameters, duplicate cursors, and oversized pages before authorization', async () => {
    const h = setup();
    withAgents(h);
    expect((await h.list('a1', '?search=alpha')).status).toBe(400);
    expect((await h.list('a1', '?limit=26')).status).toBe(400);
    expect((await h.list('a1', '?limit=0')).status).toBe(400);
    expect((await h.list('a1', '?cursor=a&cursor=b')).status).toBe(400);
  });

  it('emits only the minimal no-store projection and logs nothing', async () => {
    const h = setup();
    withAgents(h);
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'info')];
    await h.settings('owner_a', '!pub_a', 'public', 'Alpha public');
    const response = await h.list('b1');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe('application/json');
    const text = await response.text();
    const body = JSON.parse(text) as { items: Array<Record<string, unknown>> };
    expect(Object.keys(body).sort()).toEqual(['items', 'nextCursor', 'v']);
    expect(Object.keys(body.items[0]!).sort()).toEqual(['listingRef', 'requestState', 'serviceKind', 'title', 'v', 'visibility']);
    expect(body.items[0]).toMatchObject({ visibility: 'public', serviceKind: 'external', requestState: 'not_requested' });
    for (const forbidden of ['!pub_a', 'owner_a', 'roomId', 'participant', 'count', 'total', 'lastActivity', 'topic']) {
      expect(text).not.toContain(forbidden);
    }
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it('rate limits listing per session generation per minute', async () => {
    const h = setup();
    withAgents(h);
    for (let index = 0; index < LIST_REQUESTS_PER_WINDOW; index += 1) expect((await h.list('b1')).status).toBe(200);
    const limited = await h.list('b1');
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'rate_limited' });
    expect((await h.list('b2')).status).toBe(200);
    h.advance(LIST_WINDOW_MS);
    expect((await h.list('b1')).status).toBe(200);
  });
});

describe('snapshot cursors', () => {
  async function paged() {
    const h = setup();
    withAgents(h);
    h.known.set('owner_a:agent_b', { agentOwnerId: 'owner_b', currentGeneration: 4 });
    for (const [room, title] of [['!c1', 'Charlie'], ['!c2', 'Alpha'], ['!c3', 'Bravo']]) {
      h.channel(room!, 'owner_a');
      await h.settings('owner_a', room!, 'public', title!);
    }
    await h.settings('owner_a', '!priv_a', 'private', 'Delta');
    await h.allowlist('owner_a', 'allow', '!priv_a', 'agent_b', 4);
    const first = await h.page('b1', '?limit=1');
    expect(first.items.map(item => item.title)).toEqual(['Alpha']);
    return { h, cursor: first.nextCursor! };
  }

  it('pages a stable title-ordered snapshot to completion', async () => {
    const { h, cursor } = await paged();
    const second = await h.page('b1', `?limit=1&cursor=${cursor}`);
    expect(second.items.map(item => item.title)).toEqual(['Bravo']);
    const third = await h.page('b1', `?limit=5&cursor=${second.nextCursor}`);
    expect(third.items.map(item => item.title)).toEqual(['Charlie', 'Delta']);
    expect(third.nextCursor).toBeNull();
  });

  it.each([
    ['title', (h: ReturnType<typeof setup>) => h.settings('owner_a', '!c3', 'public', 'Bravo renamed')],
    ['visibility', (h: ReturnType<typeof setup>) => h.settings('owner_a', '!c3', 'secret', null)],
    ['allowlist', (h: ReturnType<typeof setup>) => h.allowlist('owner_a', 'revoke', '!priv_a', 'agent_b', 4)],
  ])('invalidates the snapshot after a %s mutation', async (_name, change) => {
    const { h, cursor } = await paged();
    expect((await change(h)).status).toBe(200);
    const response = await h.list('b1', `?limit=1&cursor=${cursor}`);
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: 'cursor_unavailable' });
  });

  it('refuses foreign, tampered, expired, and other-generation cursors identically', async () => {
    const { h, cursor } = await paged();
    h.callers.set('b1-gen5', { ownerId: 'owner_b', principal: 'agent_b', generation: 5 });
    h.callers.set('b1-otherkey', { ownerId: 'owner_b', principal: 'agent_b', generation: 4, jkt: 'q'.repeat(43) });
    const outcomes = [
      await h.list('b2', `?cursor=${cursor}`),
      await h.list('b1-gen5', `?cursor=${cursor}`),
      await h.list('b1-otherkey', `?cursor=${cursor}`),
      await h.list('b1', `?cursor=${cursor.replace(/\.1$/u, '.9')}`),
      await h.list('b1', `?cursor=${cursor.slice(0, -3)}AAA.1`),
      await h.list('b1', '?cursor=not-a-cursor'),
    ];
    h.advance(SNAPSHOT_TTL_MS);
    outcomes.push(await h.list('b1', `?cursor=${cursor}`));
    for (const response of outcomes) {
      expect(response.status).toBe(410);
      expect(await response.text()).toBe('{"error":"cursor_unavailable"}');
    }
  });
});

describe('review regressions', () => {
  it('keeps cursors valid across mutations to channels the caller cannot see', async () => {
    const h = setup();
    withAgents(h);
    for (const [room, title] of [['!c1', 'Alpha'], ['!c2', 'Bravo']]) {
      h.channel(room!, 'owner_a');
      await h.settings('owner_a', room!, 'public', title!);
    }
    await h.settings('owner_a', '!priv_a', 'private', 'Hidden from b');
    const first = await h.page('b1', '?limit=1');
    await h.settings('owner_a', '!priv_a', 'private', 'Renamed, still hidden');
    await h.settings('owner_a', '!secret_a', 'secret', null);
    await h.settings('owner_b', '!priv_b', 'private', 'Beta');
    expect((await h.page('b1', `?limit=1&cursor=${first.nextCursor}`)).items.map(item => item.title)).toEqual(['Bravo']);
  });

  it('enforces the list budget under a concurrent burst', async () => {
    const h = setup();
    withAgents(h);
    const statuses = (await Promise.all(Array.from({ length: 25 }, () => h.list('b1')))).map(response => response.status);
    // Contended writers fail closed (503) rather than being admitted twice.
    expect(statuses.every(status => status === 200 || status === 429 || status === 503)).toBe(true);
    let admitted = statuses.filter(status => status === 200).length;
    for (;;) {
      const status = (await h.list('b1')).status;
      if (status === 429) break;
      if (status === 200) admitted += 1;
    }
    expect(admitted).toBe(LIST_REQUESTS_PER_WINDOW);
  });

  it('hides a channel from listings once its recorded owner loses ownership', async () => {
    const h = setup();
    withAgents(h);
    h.known.set('owner_a:agent_b', { agentOwnerId: 'owner_b', currentGeneration: 4 });
    await h.settings('owner_a', '!priv_a', 'private', 'Alpha private');
    await h.allowlist('owner_a', 'allow', '!priv_a', 'agent_b', 4);
    expect(await h.titles('a1')).toEqual(['Alpha private']);
    expect(await h.titles('b1')).toEqual(['Alpha private']);
    h.owners.set('!priv_a', 'owner_c');
    expect(await h.titles('a1')).toEqual([]);
    expect(await h.titles('b1')).toEqual([]);
  });

  it('writes nothing for secret on a never-registered channel', async () => {
    const h = setup();
    withAgents(h);
    const response = await h.settings('owner_a', '!absent_a', 'secret', null);
    expect(await response.json()).toEqual({ v: 1, kind: 'applied', revision: null });
    expect(h.store.records.has(CATALOG_KEY)).toBe(false);
  });

  it('never lets one owner operation ID name two different writes, even across channels', async () => {
    const h = setup();
    withAgents(h);
    const body = { v: 1, operationId: 'owner-op', visibility: 'public', title: 'Alpha', expectedRevision: null };
    expect((await h.mutate(SETTINGS_PATH, 'PUT', 'owner_a', { ...body, roomId: '!pub_a' })).status).toBe(200);
    const reused = await h.mutate(SETTINGS_PATH, 'PUT', 'owner_a', { ...body, roomId: '!priv_a' });
    expect(await reused.json()).toEqual({ v: 1, kind: 'rejected', code: 'operation_mismatch' });
    expect(await h.titles('a1')).toEqual(['Alpha']);

    // A late retry still replays its original result after later mutations to the same channel.
    await h.mutate(SETTINGS_PATH, 'PUT', 'owner_a', { ...body, operationId: 'later', roomId: '!pub_a', title: 'Later', expectedRevision: '1' });
    const retry = await h.mutate(SETTINGS_PATH, 'PUT', 'owner_a', { ...body, roomId: '!pub_a' });
    expect(await retry.json()).toEqual({ v: 1, kind: 'applied', revision: '1' });
    expect(await h.titles('a1')).toEqual(['Later']);
  });

  it('validates titles inside the catalog operation, not only at the route', async () => {
    const h = setup();
    withAgents(h);
    const { setVisibility } = await import('./catalog');
    const result = await setVisibility({
      store: h.store.store, clock: () => T0, publicDiscovery: 'enabled',
      ownerAuthority: { canManage: async () => 'allowed' }, principals: { inspect: async () => ({ kind: 'unknown' }) },
    }, { v: 1, operationId: 'direct', roomId: '!pub_a' as never, visibility: 'public', title: null, expectedRevision: null }, principal('owner_a'));
    expect(result).toEqual({ kind: 'rejected', code: 'invalid_title' });
    expect(h.store.records.has(CATALOG_KEY)).toBe(false);
  });
});

describe('listing-reference resolution', () => {
  const caller = (token: string, callers: Map<string, Caller>) => {
    const held = callers.get(token)!;
    return {
      ownerId: held.ownerId as OwnerId,
      requester: {
        principal: held.principal as StableAgentPrincipal, origin: ORIGIN, sessionGeneration: held.generation,
        proofKey: { algorithm: 'Ed25519' as const, publicKey: 'k'.repeat(43), thumbprint: held.jkt ?? JKT },
      },
    };
  };

  async function listed() {
    const h = setup();
    withAgents(h);
    await h.settings('owner_a', '!pub_a', 'public', 'Alpha public');
    const ref = (await h.page('b1')).items[0]!.listingRef!;
    return { h, ref };
  }

  it('resolves only for the listing requester and never writes', async () => {
    const { h, ref } = await listed();
    const before = JSON.stringify([...h.store.records.entries()]);
    const resolved = await h.handlers.resolveListingRef(caller('b1', h.callers), ref);
    expect(resolved.kind).toBe('resolved');
    expect(JSON.stringify(resolved)).not.toContain('!pub_a');
    h.callers.set('b1-gen5', { ownerId: 'owner_b', principal: 'agent_b', generation: 5 });
    expect(await h.handlers.resolveListingRef(caller('b2', h.callers), ref)).toEqual({ kind: 'unavailable' });
    expect(await h.handlers.resolveListingRef(caller('b1-gen5', h.callers), ref)).toEqual({ kind: 'unavailable' });
    expect(await h.handlers.resolveListingRef(caller('b1', h.callers), `${ref.slice(0, -2)}AA`)).toEqual({ kind: 'unavailable' });
    expect(await h.handlers.resolveListingRef(caller('b1', h.callers), 'dlr_garbage')).toEqual({ kind: 'unavailable' });
    expect(JSON.stringify([...h.store.records.entries()])).toBe(before);
  });

  it('rechecks expiry, current visibility, and channel ownership', async () => {
    const expired = await listed();
    expired.h.advance(SNAPSHOT_TTL_MS);
    expect(await expired.h.handlers.resolveListingRef(caller('b1', expired.h.callers), expired.ref)).toEqual({ kind: 'unavailable' });

    const hidden = await listed();
    await hidden.h.settings('owner_a', '!pub_a', 'secret', null);
    expect(await hidden.h.handlers.resolveListingRef(caller('b1', hidden.h.callers), hidden.ref)).toEqual({ kind: 'unavailable' });

    const orphaned = await listed();
    orphaned.h.owners.delete('!pub_a');
    expect(await orphaned.h.handlers.resolveListingRef(caller('b1', orphaned.h.callers), orphaned.ref)).toEqual({ kind: 'unavailable' });
  });
});

describe('wrong implementation: secret channels leak through enumeration', () => {
  async function crawl(withSecret: boolean) {
    const h = setup({ random: countingRandom() });
    withAgents(h);
    for (const [room, title] of [['!p1', 'Alpha'], ['!p2', 'Bravo'], ['!p3', 'Charlie']]) {
      h.channel(room!, 'owner_a');
      await h.settings('owner_a', room!, 'public', title!);
    }
    if (withSecret) {
      // Published once, then made secret: its tombstone sits beside the public entries.
      h.channel('!hidden', 'owner_a');
      await h.settings('owner_a', '!hidden', 'private', 'Alpha hidden');
      await h.settings('owner_a', '!hidden', 'secret', null);
    }
    const bodies: string[] = [];
    let query = '?limit=2';
    for (;;) {
      const response = await h.list('a1', query);
      bodies.push(`${response.status} ${await response.text()}`);
      if (withSecret && bodies.length === 1) {
        // Mid-crawl churn on the invisible channel must not be observable either.
        expect((await h.settings('owner_a', '!hidden', 'secret', null)).status).toBe(200);
      }
      const next = response.status === 200 ? (JSON.parse(bodies.at(-1)!.slice(4)) as { nextCursor: string | null }).nextCursor : null;
      if (!next) break;
      query = `?limit=2&cursor=${next}`;
    }
    return bodies;
  }

  it('produces byte-identical pages and page counts with or without a secret channel', async () => {
    const absent = await crawl(false);
    const present = await crawl(true);
    expect(absent).toHaveLength(2);
    expect(present).toEqual(absent);
  });
});
