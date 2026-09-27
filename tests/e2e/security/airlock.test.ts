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
import { createSurfaceCapture, describeLeaks, mintCanary, scanTree } from './fixtures';
import { CLI_UNCOMPOSED, SURFACE_INVENTORY, surfacesFor } from './inventory';
import { type InternalWorld, bobBinding, channelId, otherChannelId, startInternalWorld } from './internal-world';
import { CLI_PROBES, HTTP_PROBES, MCP_PROBES, type Seeded, add, expectSealed, runFamily } from './probes';
import { runGatedRelease } from './hosted-world';

const worlds: InternalWorld[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.close();
  await closeHostedWorlds();
});

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
