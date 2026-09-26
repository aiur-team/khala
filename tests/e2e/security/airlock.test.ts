// U2: unreleased content never reaches a model-facing surface.
//
// Internal mode (KHA-133 wiring) has no review step: every human message in a
// channel the agent is bound to is released to it. What must never reach the agent
// is content it was not released: a message in a channel its binding is not joined
// to. Each probe family drives the inventoried surfaces of one kind through the real
// server, store, CLI and MCP server, with a fresh `pending` canary in the other
// channel and an `approved` canary in the agent's own. The approved canary appearing
// on the content-bearing surfaces is the positive control that the probe reached
// real content at all.
//
// Hosted mode's review gate (KHA-134) is proven by `dispatcher-gate`: the real
// ledger, release policy, review handler and dispatcher, with the real Codex adapter
// over its fake app-server as the model session.

import { afterEach, describe, expect, it } from 'vitest';
import { closeHostedWorlds } from './hosted-world';
import {
  type Canary, type SurfaceCapture, createSurfaceCapture, describeLeaks, mintCanary, scanTree,
} from './fixtures';
import { surfacesFor } from './inventory';
import { type InternalWorld, bobBinding, channelId, otherChannelId, startInternalWorld } from './internal-world';
import { runGatedRelease } from './hosted-world';

const worlds: InternalWorld[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.close();
  await closeHostedWorlds();
});

type Seeded = Readonly<{ world: InternalWorld; pending: Canary; approved: Canary; capture: SurfaceCapture }>;

async function seeded(): Promise<Seeded> {
  const world = await startInternalWorld();
  worlds.push(world);
  const pending = mintCanary('pending');
  const approved = mintCanary('approved');
  world.say(otherChannelId, `before ${pending.text}`);
  world.say(channelId, `released ${approved.text}`);
  world.say(otherChannelId, `after ${pending.text}`);
  return { world, pending, approved, capture: createSurfaceCapture() };
}

type Probe = (seed: Seeded) => Promise<void>;

/** Runs one probe per inventoried surface; a listed surface without a probe fails. */
async function runFamily(family: Parameters<typeof surfacesFor>[0], probes: Readonly<Record<string, Probe>>, seed: Seeded) {
  const listed = surfacesFor(family);
  expect(listed.filter(id => !(id in probes)), `${family}: inventoried surfaces without a probe`).toEqual([]);
  expect(Object.keys(probes).filter(id => !listed.includes(id)), `${family}: probes for surfaces not inventoried here`).toEqual([]);
  for (const id of listed) await probes[id]!(seed);
  expect(seed.capture.surfaces().length).toBeGreaterThanOrEqual(listed.length);
}

/** No pending canary on any captured surface, in the server logs or the agent's state. */
function expectSealed(seed: Seeded) {
  const leaks = [
    ...seed.capture.leaks([seed.pending]),
    ...scanTree(seed.world.agentState, [seed.pending]),
  ];
  expect(leaks, describeLeaks(leaks)).toEqual([]);
  const logs = JSON.stringify(seed.world.logs);
  expect(logs.includes(seed.pending.core) || logs.includes(seed.approved.core), 'server log carries a message body').toBe(false);
}

const add = (seed: Seeded, where: string, run: { out: string; err: string } | { status: number; body: string }) =>
  seed.capture.add(where, 'body' in run ? `${run.status} ${run.body}` : `${run.out}\n${run.err}`);

const channelRoute = (id: string, suffix = '') => `/api/v1/channels/${encodeURIComponent(id)}${suffix}`;

/** Every route is tried against the agent's own channel and the channel it was never joined to. */
const HTTP_PROBES: Readonly<Record<string, Probe>> = {
  'http-internal:GET /__khala/bootstrap': async s => add(s, 'GET /__khala/bootstrap', await s.world.http('GET', '/__khala/bootstrap', { bearer: null })),
  'http-internal:GET /__khala/bootstrap.js': async s => add(s, 'GET /__khala/bootstrap.js', await s.world.http('GET', '/__khala/bootstrap.js', { bearer: null })),
  'http-internal:POST /__khala/session': async s => {
    // An agent tries to turn its binding bearer into a human browser session for the other channel.
    const forged = await s.world.http('POST', '/__khala/session', { bearer: null, origin: true, body: { credential: s.world.bearer, channelId: otherChannelId } });
    expect(forged.status).toBe(401);
    add(s, 'POST /__khala/session', forged);
  },
  'http-internal:GET /api/v1/session': async s => add(s, 'GET /api/v1/session', await s.world.http('GET', '/api/v1/session')),
  'http-internal:POST /api/v1/channels': async s => {
    const created = await s.world.http('POST', '/api/v1/channels', { body: { operationId: 'op-agent-create', title: 'agent' } });
    expect(created.status).toBe(403);
    add(s, 'POST /api/v1/channels', created);
  },
  'http-internal:GET /api/v1/channels/:channelId': async s => {
    for (const id of [channelId, otherChannelId]) add(s, `GET channel ${id}`, await s.world.http('GET', channelRoute(id)));
    expect((await s.world.http('GET', channelRoute(otherChannelId))).status).toBe(403);
  },
  'http-internal:GET /api/v1/channels/:channelId/timeline': async s => {
    const own = await s.world.http('GET', channelRoute(channelId, '/timeline'));
    const other = await s.world.http('GET', channelRoute(otherChannelId, '/timeline'));
    add(s, 'GET timeline own', own);
    add(s, 'GET timeline other', other);
    expect(other.status).toBe(403);
    // Traversal and encoded forms of the other channel, sent unnormalized, never reach its timeline.
    for (const route of [
      `/api/v1/channels/${channelId}/../${otherChannelId}/timeline`,
      `/api/v1/channels/${channelId}/%2e%2e/${otherChannelId}/timeline`,
      `/api/v1/channels/${channelId}%2F..%2F${otherChannelId}/timeline`,
      `/api/v1/channels/${otherChannelId}%2F/timeline`,
    ]) {
      const variant = await s.world.raw(route);
      expect([400, 403, 404], route).toContain(variant.status);
      add(s, 'GET timeline variant', variant);
    }
  },
  'http-internal:POST /api/v1/channels/:channelId/messages': async s => {
    const cross = await s.world.http('POST', channelRoute(otherChannelId, '/messages'), { body: { clientTxnId: 'txn-agent', content: { v: 1, kind: 'text', body: 'x' } } });
    expect(cross.status).toBe(403);
    add(s, 'POST messages other', cross);
  },
  'http-internal:GET /api/v1/channels/:channelId/hints': async s => {
    // A live hint stream while new pending and released messages arrive.
    const during = () => {
      s.world.say(otherChannelId, `live ${s.pending.text}`);
      s.world.say(channelId, `live ${s.approved.text}`);
    };
    const own = await s.world.stream(channelRoute(channelId, '/hints'), during, 500);
    expect(own.status).toBe(200);
    expect(own.body).toContain('event: ready');
    add(s, 'GET hints own', own);
    const other = await s.world.http('GET', channelRoute(otherChannelId, '/hints'));
    expect(other.status).toBe(403);
    add(s, 'GET hints other', other);
  },
  'http-internal:GET /api/v1/agent/binding': async s => add(s, 'GET binding', await s.world.http('GET', '/api/v1/agent/binding')),
  'http-internal:GET /api/v1/channels/:channelId/releases': async s => {
    const own = await s.world.http('GET', channelRoute(channelId, '/releases?limit=50'));
    const other = await s.world.http('GET', channelRoute(otherChannelId, '/releases?limit=50'));
    add(s, 'GET releases own', own);
    add(s, 'GET releases other', other);
    expect(other.status).toBe(403);
  },
  'http-internal:GET /channels/:channelId': async s => {
    for (const id of [channelId, otherChannelId]) add(s, `GET page ${id}`, await s.world.http('GET', `/channels/${id}`, { bearer: null }));
  },
};

const hookInput = (event: string) => JSON.stringify({ hook_event_name: event, session_id: bobBinding.sessionId, turn_id: 'turn-1' });

const CLI_PROBES: Readonly<Record<string, Probe>> = {
  'cli:connect': async s => add(s, 'cli:connect', await s.world.khala(['connect'])),
  'cli:listen': async s => add(s, 'cli:listen', await s.world.khala(['listen'], { descriptor: true, abortAfterMs: 1_000 })),
  'cli:mode': async s => add(s, 'cli:mode', await s.world.khala(['mode'])),
  'cli:read': async s => add(s, 'cli:read', await s.world.khala(['read'], { descriptor: true })),
  'cli:send': async s => add(s, 'cli:send', await s.world.khala(['send'], { descriptor: true, stdin: 'a reply' })),
  'cli:status': async s => add(s, 'cli:status', await s.world.khala(['status'], { descriptor: true })),
  'cli:channels': async s => add(s, 'cli:channels', await s.world.khala(['channels', 'list'])),
  'cli:agents': async s => add(s, 'cli:agents', await s.world.khala(['agents', 'list', bobBinding.bindingId])),
  'cli:join': async s => add(s, 'cli:join', await s.world.khala(['join', `${s.world.server.origin}/channels/${otherChannelId}`], { descriptor: true })),
  'cli:pair': async s => add(s, 'cli:pair', await s.world.khala(['pair', '7K3QX-9MZ2P'])),
  'cli:claude': async s => add(s, 'cli:claude', await s.world.khala(['claude'])),
  'cli:codex-hook': async s => add(s, 'cli:codex-hook', await s.world.khala(['codex-hook'], { client: 'internal', stdin: hookInput('Stop') })),
  ...Object.fromEntries(['pull', 'read', 'send', 'status', 'mode', 'pending', 'hook'].map(op => [
    `claude-op:${op}`,
    (async s => add(s, `claude-op:${op}`, await s.world.khala(['claude', op], { stdin: hookInput('Stop') }))) as Probe,
  ])),
  ...Object.fromEntries(['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop'].map(event => [
    `hook-codex:${event}`,
    (async s => add(s, `hook-codex:${event}`, await s.world.khala(['codex-hook'], { client: 'internal', stdin: hookInput(event) }))) as Probe,
  ])),
};

const MCP_ARGS: Readonly<Record<string, Record<string, unknown>>> = {
  khala_read: {},
  khala_send: { message: 'a reply' },
  khala_listening_mode: { action: 'get' },
  khala_list_channels: {},
  khala_list_agents: { channel: bobBinding.bindingId },
  khala_request_channel_access: { target: `http://127.0.0.1/channels/${otherChannelId}` },
  khala_channel_access_status: { operationId: 'op-probe' },
  khala_pair: { code: '7K3QX-9MZ2P' },
};

/** One `khala mcp-serve` session that lists tools and calls each inventoried one. */
async function mcpSession(s: Seeded): Promise<void> {
  const tools = surfacesFor('mcp-serve').filter(id => id.startsWith('mcp-tool:')).map(id => id.slice('mcp-tool:'.length));
  const lines = [
    { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'kha138', version: '1' } } },
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    ...tools.map((name, index) => ({ jsonrpc: '2.0', id: 10 + index, method: 'tools/call', params: { name, arguments: MCP_ARGS[name] } })),
    { jsonrpc: '2.0', id: 99, method: 'resources/list' },
  ];
  const run = await s.world.khala(['mcp-serve'], { descriptor: true, stdin: lines.map(line => JSON.stringify(line)).join('\n') + '\n' });
  add(s, 'cli:mcp-serve', run);
  const responses = run.out.split('\n').filter(Boolean).map(line => JSON.parse(line) as { id: number });
  for (const [index, name] of tools.entries()) {
    const response = responses.find(candidate => candidate.id === 10 + index);
    expect(response, name).toBeDefined();
    s.capture.add(`mcp-tool:${name}`, JSON.stringify(response));
  }
}

const MCP_PROBES: Readonly<Record<string, Probe>> = {
  'cli:mcp-serve': mcpSession,
  // The session above answers every tool. Every inbox-surface tool result appends the
  // unacknowledged batch, so its own response must carry the released canary: proof the
  // probe reached a content-bearing path on that tool, not just an error. `khala_pair` is
  // not an inbox surface (mcp/pair.ts) and carries no batch; its response is still scanned.
  ...Object.fromEntries(Object.keys(MCP_ARGS).map(name => [
    `mcp-tool:${name}`,
    (async s => {
      const carrying = s.capture.carrying(s.approved);
      if (name === 'khala_pair') expect(carrying).not.toContain(`mcp-tool:${name}`);
      else expect(carrying).toContain(`mcp-tool:${name}`);
    }) as Probe,
  ])),
};

describe('agent-facing surfaces never carry content the agent was not released', () => {
  it('internal-http: every loopback route, with the agent binding and without credentials', async () => {
    const seed = await seeded();
    await runFamily('internal-http', HTTP_PROBES, seed);
    expectSealed(seed);
    expect(seed.capture.carrying(seed.approved)).toEqual(expect.arrayContaining(['GET timeline own', 'GET releases own']));
  });

  it('agent-cli: every command, claude op and codex hook event as installed', async () => {
    const seed = await seeded();
    await runFamily('agent-cli', CLI_PROBES, seed);
    expectSealed(seed);
    // `listen` runs first and acknowledges the release, so it is the surface that carries it.
    expect(seed.capture.carrying(seed.approved)).toContain('cli:listen');
  });

  it('mcp-serve: tools/list and every registered tool in one session', async () => {
    const seed = await seeded();
    await runFamily('mcp-serve', MCP_PROBES, seed);
    expectSealed(seed);
    expect(seed.capture.carrying(seed.approved)).toContain('mcp-tool:khala_read');
  });

  it('positive leak control: a canary placed where the agent may read it is reported on the same probes', async () => {
    const seed = await seeded();
    // The "pending" canary deliberately posted into the agent's own channel.
    seed.world.say(channelId, `leaked ${seed.pending.text}`);
    await runFamily('internal-http', HTTP_PROBES, seed);
    await runFamily('mcp-serve', MCP_PROBES, seed);
    const leaked = seed.capture.leaks([seed.pending]).map(leak => leak.where);
    expect(leaked).toEqual(expect.arrayContaining(['GET timeline own', 'GET releases own', 'mcp-tool:khala_read']));
    expect(scanTree(seed.world.agentState, [seed.pending])).not.toEqual([]);
  });

  it('dispatcher-gate: only the approved event reaches the existing session, through the real adapter', async () => {
    const result = await runGatedRelease();
    const leaks = result.capture.leaks([result.pending]);
    expect(leaks, describeLeaks(leaks)).toEqual([]);
    expect(result.capture.carrying(result.approved)).toEqual(['model:codex-app-server']);
    // Only the Codex adapter is driven; the other adapters are inventoried as not observed.
    expect(surfacesFor('dispatcher-gate')).toEqual(['harness-adapter:codex']);
  });
});
