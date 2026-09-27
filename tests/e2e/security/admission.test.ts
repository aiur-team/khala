// Admission boundary conformance (#453): a binding admitted to a channel sees only what its
// admission shares, on every surface that admits a binding principal.
//
// An agent is admitted with `history: none`, stopped, and admitted again. Everything said
// before the second admission (before any admission, to the first binding, and while no
// agent was bound) carries the `pending` canary; what is said after it carries `approved`.
// The re-admitted binding then drives every inventoried surface through the probe families
// `airlock.test.ts` uses, so a surface added to the inventory is driven here too. No surface
// may carry `pending`; the content-bearing ones must carry `approved`. A binding admitted
// with the owner's history shared sees all of it. Hand-built early cursors, a human's
// timeline cursor and a feed cursor from the start of the channel, reach nothing earlier
// either. Wrong-implementation tests compose a read path that bypasses the admission
// boundary and require the scan to fail naming that surface.

import { afterEach, describe, expect, it } from 'vitest';
import { encodeSubscriptionCursor } from '../../../apps/internal/src/store/cursors';
import type { ChannelStore } from '../../../apps/internal/src/store/channel-store';
import { type Canary, createSurfaceCapture, describeLeaks, mintCanary, scanTree } from './fixtures';
import { type ProbeId, PROBES, SURFACE_INVENTORY } from './inventory';
import { type InternalWorld, channelId, startInternalWorld } from './internal-world';
import { CLI_PROBES, HTTP_PROBES, MCP_PROBES, type Probe, type Seeded, add, channelRoute, runFamily } from './probes';

const worlds: InternalWorld[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.close();
});

/** The probe families whose surfaces admit an internal-mode binding principal: its bearer or its descriptor. */
const BINDING_FAMILIES: Readonly<Partial<Record<ProbeId, Readonly<Record<string, Probe>>>>> = {
  'internal-http': HTTP_PROBES,
  'agent-cli': CLI_PROBES,
  'mcp-serve': MCP_PROBES,
};

/** Every other probe family, and why no internal binding principal reaches it. */
const NOT_BINDING_FAMILIES: Readonly<Partial<Record<ProbeId, string>>> = {
  'claude-session': 'admits the launch transport capability and a harness session, which reads no channel content in this build',
  'internal-discovery': 'admits an unjoined agent\'s transport and discovery capabilities, before any binding exists',
  'dispatcher-gate': 'hosted review gate: the owner-approved release is the only content the session receives',
};

/** Surfaces that must carry what was said after the admission, per family: proof the probe read real content. */
const CONTENT_BEARING: Readonly<Partial<Record<ProbeId, readonly string[]>>> = {
  'internal-http': ['GET timeline own', 'GET releases own'],
  'agent-cli': ['cli:listen', 'cli:read'],
  'mcp-serve': ['mcp-tool:khala_read'],
};

/** Surfaces that must carry shared earlier history, per family. `listen` acknowledges it, so `read` has only newer content. */
const HISTORY_BEARING: Readonly<Partial<Record<ProbeId, readonly string[]>>> = {
  'internal-http': ['GET timeline own', 'GET releases own'],
  'agent-cli': ['cli:listen'],
  'mcp-serve': ['mcp-tool:khala_read'],
};

/** Admitted, stopped and admitted again, with earlier history only in `pending`. */
async function readmitted(history: 'none' | 'shared', options: Parameters<typeof startInternalWorld>[0] = {}): Promise<Seeded> {
  const world = await startInternalWorld(options);
  worlds.push(world);
  const pending = mintCanary('before-admission');
  const approved = mintCanary('after-admission');
  world.say(channelId, `before any admission ${pending.text}`);
  world.stop();
  world.admit('none');
  world.say(channelId, `to the first admission ${pending.text}`);
  world.stop();
  world.say(channelId, `while no agent was bound ${pending.text}`);
  world.admit(history);
  world.say(channelId, `after the admission ${approved.text}`);
  return { world, pending, approved, capture: createSurfaceCapture() };
}

function leaksOf(seed: Seeded, canary: Canary) {
  return [...seed.capture.leaks([canary]), ...scanTree(seed.world.agentState, [canary])];
}

describe('the admission boundary holds on every surface that admits a binding principal', () => {
  it('every inventoried probe family is classified as admitting a binding principal or not', () => {
    const families = new Set(Object.values(SURFACE_INVENTORY).flatMap(coverage => coverage.kind === 'probe' ? [coverage.probe] : []));
    expect([...families].filter(family => !(family in BINDING_FAMILIES) && !(family in NOT_BINDING_FAMILIES))).toEqual([]);
    expect(PROBES.filter(family => !families.has(family))).toEqual([]);
  });

  it.each(Object.keys(BINDING_FAMILIES) as ProbeId[])('%s: a binding re-admitted with history none sees nothing from before its admission', async family => {
    const seed = await readmitted('none');
    await runFamily(family, BINDING_FAMILIES[family]!, seed);
    const leaks = leaksOf(seed, seed.pending);
    expect(leaks, describeLeaks(leaks)).toEqual([]);
    expect(seed.capture.carrying(seed.approved)).toEqual(expect.arrayContaining([...CONTENT_BEARING[family]!]));
  });

  it.each(Object.keys(BINDING_FAMILIES) as ProbeId[])('%s: a binding admitted with the owner\'s history shared sees all of it', async family => {
    const seed = await readmitted('shared');
    await runFamily(family, BINDING_FAMILIES[family]!, seed);
    expect(seed.capture.carrying(seed.pending)).toEqual(expect.arrayContaining([...HISTORY_BEARING[family]!]));
  });

  it('internal-http: replayed early cursors reach nothing from before the admission', async () => {
    const seed = await readmitted('none');
    const { world } = seed;
    // A human's cursor into the earlier history, from the human's own timeline.
    const human = world.fixture.store.timeline({
      channelId, participantId: world.fixture.bootstrap.human.participantId, reader: { kind: 'member' }, cursor: null, limit: 1,
    });
    if (human.kind !== 'done' || human.nextCursor === null) throw new Error('expected a human timeline cursor');
    const timeline = await world.http('GET', channelRoute(channelId, `/timeline?cursor=${encodeURIComponent(human.nextCursor)}`));
    expect(timeline.status).toBe(200);
    add(seed, 'GET timeline human cursor', timeline);
    // A feed cursor built by hand at the start of the channel, for the held binding.
    const binding = world.binding();
    const early = encodeSubscriptionCursor({ channelId, bindingId: binding.bindingId, generation: binding.generation, lastCoveredSequence: 0 });
    const releases = await world.http('GET', channelRoute(channelId, `/releases?limit=50&cursor=${encodeURIComponent(early)}`));
    expect(releases.status).toBe(200);
    add(seed, 'GET releases early cursor', releases);
    const leaks = leaksOf(seed, seed.pending);
    expect(leaks, describeLeaks(leaks)).toEqual([]);
    expect(seed.capture.carrying(seed.approved)).toEqual(['GET releases early cursor']);
  });

  // Wrong implementations: one read path bypasses the admission boundary, and the scan names that surface.
  const bypasses: ReadonlyArray<readonly [string, (store: ChannelStore) => ChannelStore, readonly string[], readonly string[]]> = [
    [
      'a timeline that reads as a member',
      store => ({ ...store, timeline: input => store.timeline({ ...input, reader: { kind: 'member' } }) }),
      ['GET timeline own'],
      ['GET releases own', 'mcp-tool:khala_read'],
    ],
    [
      'a feed that serves the whole channel on its first page',
      store => ({
        ...store,
        readSubscription(input) {
          const page = store.readSubscription(input);
          if (input.cursor !== null || page.kind !== 'page') return page;
          const all = store.timeline({
            channelId: input.channelId, participantId: input.binding.agentParticipantId, reader: { kind: 'member' }, cursor: null, limit: 100,
          });
          return all.kind === 'done' ? { ...page, events: all.events } : page;
        },
      }),
      ['GET releases own', 'mcp-tool:khala_read'],
      ['GET timeline own'],
    ],
  ];

  it.each(bypasses)('wrong implementation: %s fails the scan and is named', async (_name, bypass, named, sealed) => {
    const leaked = new Set<string>();
    for (const [family, probes] of [['internal-http', HTTP_PROBES], ['mcp-serve', MCP_PROBES]] as const) {
      const seed = await readmitted('none', { store: bypass });
      await runFamily(family, probes, seed);
      for (const leak of leaksOf(seed, seed.pending)) leaked.add(leak.where);
    }
    expect([...leaked]).toEqual(expect.arrayContaining([...named]));
    expect(sealed.filter(surface => leaked.has(surface))).toEqual([]);
  });
});
