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
import { CLI_UNCOMPOSED, SURFACE_INVENTORY, surfacesFor } from './inventory';
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
  'http-internal:GET /api/v1/channels/:channelId/receipts': async s => {
    // Owner-only receipt evidence: the agent binding is refused by role for either channel.
    for (const id of [channelId, otherChannelId]) {
      const receipts = await s.world.http('GET', channelRoute(id, '/receipts'));
      expect(receipts.status).toBe(403);
      add(s, `GET receipts ${id}`, receipts);
    }
  },
  'http-internal:POST /api/v1/channels/:channelId/stop': async s => {
    // Human-only Stop: the agent binding cannot revoke bindings in either channel, and its own read still works.
    for (const id of [channelId, otherChannelId]) {
      const stopped = await s.world.http('POST', channelRoute(id, '/stop'), { body: { v: 1, targets: null } });
      expect(stopped.status).toBe(403);
      add(s, `POST stop ${id}`, stopped);
    }
    expect((await s.world.http('GET', channelRoute(channelId, '/timeline'))).status).toBe(200);
  },
  'http-internal:GET /api/v1/channels/:channelId/make-external': async s => {
    // Human-only Make external: the agent binding cannot read the journey view of either channel.
    for (const id of [channelId, otherChannelId]) {
      const view = await s.world.http('GET', channelRoute(id, '/make-external'));
      expect(view.status).toBe(403);
      add(s, `GET make-external ${id}`, view);
    }
  },
  'http-internal:POST /api/v1/channels/:channelId/make-external': async s => {
    // Nor act on it: a well-formed action from the binding is refused by role before it is decoded.
    for (const id of [channelId, otherChannelId]) {
      const acted = await s.world.http('POST', channelRoute(id, '/make-external'), { body: { operationId: 'op-agent', kind: 'cancel' } });
      expect(acted.status).toBe(403);
      add(s, `POST make-external ${id}`, acted);
    }
    expect((await s.world.http('GET', channelRoute(channelId, '/timeline'))).status).toBe(200);
  },
  // Owner mode control and pause: the agent binding is refused by role for its own and a foreign binding, in either channel.
  ...Object.fromEntries(([
    ['GET', '/listening-mode', undefined],
    ['POST', '/listening-mode', { v: 1, commandId: 'agent-as-owner', generation: 1, expectedVersion: 1, requested: 'async', issuedAt: 'probe' }],
    ['POST', '/pause', { v: 1, generation: 1, paused: true }],
  ] as const).map(([method, suffix, body]) => [
    `http-internal:${method} /api/v1/channels/:channelId/bindings/:bindingId${suffix}`,
    (async s => {
      for (const id of [channelId, otherChannelId]) {
        for (const binding of [bobBinding.bindingId, 'binding-carol']) {
          const reply = await s.world.http(method, channelRoute(id, `/bindings/${binding}${suffix}`), body === undefined ? {} : { body });
          expect(reply.status).toBe(403);
          add(s, `${method} owner ${suffix} ${id} ${binding}`, reply);
        }
      }
      // Nothing was paused: the agent's own releases still flow.
      expect(JSON.parse((await s.world.http('GET', channelRoute(channelId, '/releases?limit=50'))).body).held).toBeNull();
    }) as Probe,
  ])),
  'http-internal:GET /api/v1/channels/:channelId/bindings': async s => {
    // The owner's binding list names every agent's mode and pause: refused to the binding in either channel.
    for (const id of [channelId, otherChannelId]) {
      const listed = await s.world.http('GET', channelRoute(id, '/bindings'));
      expect(listed.status).toBe(403);
      add(s, `GET owner bindings ${id}`, listed);
    }
  },
  'http-internal:POST /api/v1/agent/harness': async s => {
    // The agent reports only its own harness observation; a target field is refused.
    const targeted = await s.world.http('POST', '/api/v1/agent/harness', {
      body: { v: 1, version: '0.156.1', hookReview: 'trusted', bindingId: 'binding-carol' },
    });
    expect(targeted.status).toBe(400);
    add(s, 'POST agent harness targeted', targeted);
    const own = await s.world.http('POST', '/api/v1/agent/harness', { body: { v: 1, version: '0.156.1', hookReview: 'trusted' } });
    expect(own.status).toBe(200);
    add(s, 'POST agent harness own', own);
  },
  // The agent's own mode: mode state only, never a message body, and no target field is accepted.
  'http-internal:GET /api/v1/agent/listening-mode': async s => {
    const own = await s.world.http('GET', '/api/v1/agent/listening-mode');
    expect(own.status).toBe(200);
    add(s, 'GET agent listening-mode', own);
    add(s, 'GET agent listening-mode unauthenticated', await s.world.http('GET', '/api/v1/agent/listening-mode', { bearer: null }));
  },
  'http-internal:POST /api/v1/agent/listening-mode': async s => {
    const targeted = await s.world.http('POST', '/api/v1/agent/listening-mode', {
      body: { v: 1, commandId: 'agent-targeted', expectedVersion: 1, requested: 'sync', issuedAt: 'probe', bindingId: 'binding-carol' },
    });
    expect(targeted.status).toBe(400);
    add(s, 'POST agent listening-mode targeted', targeted);
    const own = await s.world.http('POST', '/api/v1/agent/listening-mode', {
      body: { v: 1, commandId: 'agent-own', expectedVersion: 1, requested: 'sync', issuedAt: 'probe' },
    });
    expect(own.status).toBe(200);
    add(s, 'POST agent listening-mode own', own);
  },
  'http-internal:GET /channels/:channelId': async s => {
    for (const id of [channelId, otherChannelId]) add(s, `GET page ${id}`, await s.world.http('GET', `/channels/${id}`, { bearer: null }));
  },
  // App-shell documents mount only with a built asset manifest; this world has none, so they answer 404.
  'http-internal:GET /channels/:channelId/settings': async s => {
    for (const id of [channelId, otherChannelId]) add(s, `GET settings page ${id}`, await s.world.http('GET', `/channels/${id}/settings`, { bearer: null }));
  },
  'http-internal:GET /channels/:channelId/make-external': async s => {
    for (const id of [channelId, otherChannelId]) add(s, `GET make-external page ${id}`, await s.world.http('GET', `/channels/${id}/make-external`, { bearer: null }));
  },
  'http-internal:GET /channel-requests': async s => {
    add(s, 'GET requests page', await s.world.http('GET', '/channel-requests', { bearer: null }));
  },
  'http-internal:GET /channel-requests/:handle': async s => {
    add(s, 'GET request page', await s.world.http('GET', '/channel-requests/alice', { bearer: null }));
  },
};

const hookInput = (event: string) => JSON.stringify({ hook_event_name: event, session_id: bobBinding.sessionId, turn_id: 'turn-1' });

const CLI_PROBES: Readonly<Record<string, Probe>> = {
  'cli:listen': async s => add(s, 'cli:listen', await s.world.khala(['listen'], { descriptor: true, abortAfterMs: 1_000 })),
  'cli:read': async s => {
    // `listen` has acknowledged the earlier release, so a fresh one gives `read` content to carry.
    s.world.say(channelId, `for read ${s.approved.text}`);
    s.world.say(otherChannelId, `for read ${s.pending.text}`);
    add(s, 'cli:read', await s.world.khala(['read'], { descriptor: true }));
  },
  'cli:send': async s => add(s, 'cli:send', await s.world.khala(['send'], { descriptor: true, stdin: 'a reply' })),
  'cli:status': async s => add(s, 'cli:status', await s.world.khala(['status'], { descriptor: true })),
  'cli:mode': async s => {
    // Mode state only, for the descriptor's own binding; without the descriptor it holds none.
    const described = await s.world.khala(['mode', 'get'], { descriptor: true });
    expect(described.out).toContain('"kind":"view"');
    add(s, 'cli:mode', described);
    const installed = await s.world.khala(['mode', 'get']);
    expect(installed.out).toContain('"reason":"unavailable"');
    add(s, 'cli:mode installed', installed);
  },
  'cli:codex-hook': async s => add(s, 'cli:codex-hook', await s.world.khala(['codex-hook'], { client: 'internal', stdin: hookInput('Stop') })),
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
  khala_create_channel: { title: 'probe', operationId: 'op-probe-create' },
  khala_channel_create_status: { operationId: 'op-probe-create' },
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

  it('agent-cli: every composed command and codex hook event, against the descriptor', async () => {
    const seed = await seeded();
    await runFamily('agent-cli', CLI_PROBES, seed);
    expectSealed(seed);
    // `listen` carries the first release and `read` the one posted after it acknowledged.
    expect(seed.capture.carrying(seed.approved)).toEqual(expect.arrayContaining(['cli:listen', 'cli:read']));
  });

  it('agent-cli: commands with no composed transport refuse with valid arguments, as installed and with a descriptor', async () => {
    const seed = await seeded();
    const origin = seed.world.server.origin;
    const commands: Readonly<Record<string, Readonly<{ args: readonly string[]; refusal: string }>>> = {
      'cli:connect': { args: ['connect', 'https://khala.example/c/kha138'], refusal: '"error":"transport_unavailable"' },
      'cli:channels': { args: ['channels', 'list', '--origin', origin], refusal: '"error":"unavailable"' },
      'cli:agents': { args: ['agents', 'list', '--channel', bobBinding.bindingId], refusal: '"error":"not_connected"' },
      'cli:pair': { args: ['pair', '7K3QX-9MZ2P'], refusal: '"error":"pairing_unavailable"' },
    };
    const reclassified = Object.entries(SURFACE_INVENTORY)
      .filter(([, coverage]) => coverage.kind === 'not-observed' && coverage.reason === CLI_UNCOMPOSED)
      .map(([id]) => id);
    expect(Object.keys(commands).sort()).toEqual(reclassified.sort());
    for (const [id, { args, refusal }] of Object.entries(commands)) {
      const installed = await seed.world.khala(args);
      expect(installed.code, id).not.toBe(0);
      expect(installed.out + installed.err, id).toContain(refusal);
      add(seed, `${id} installed`, installed);
      const described = await seed.world.khala(args, { descriptor: true });
      expect(described.err, id).toContain('"error":"invalid_arguments"');
      add(seed, `${id} descriptor`, described);
    }
    expectSealed(seed);
    expect(seed.capture.carrying(seed.approved)).toEqual([]);
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
