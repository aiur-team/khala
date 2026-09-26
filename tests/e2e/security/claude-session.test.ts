// U2: the Claude plugin's session path (KHA-133 wiring, #382) never carries content the
// session was not released.
//
// This family runs the real internal launcher, so its composition is the shipped one:
// the Claude session route admits the launch's transport capability from
// `active.json`, a session binds only through its own journaled access request and the
// owner's decision, and `khala mcp-serve` / `khala claude <op>` reach it through the
// same client `cli/main.ts` composes. The `pending` canary sits in a second owner
// channel no Claude session is granted; the `approved` canary sits in the granted
// session's own channel. An unbound bystander session must carry neither.
//
// This world's launcher claims an installed Claude Code that is not in the proven list,
// so the route is experimental (#418): `pull` and `read` deliver with batch-token
// acknowledgement, and every mode is labelled experimental. The default `sync` request
// is not effective without the owner's experimental-route grant, so hooks deliver
// nothing on their own. The approved canary is the
// positive control: it reaches the granted session's own delivery surfaces, and only
// those. The pending canary reaches nothing, and the bystander carries neither. The
// granted session's own sends landing in its channel, and only there, show the probes
// reached a real binding.

import { afterEach, describe, expect, it } from 'vitest';
import { CLAUDE_SESSION_PATH } from '../../../packages/agent-cli/src/composition/claude-session-http';
import { type Canary, type SurfaceCapture, createSurfaceCapture, describeLeaks, mintCanary } from './fixtures';
import { surfacesFor } from './inventory';
import { type LauncherWorld as World, call, closeLaunchers, launched } from './launcher-world';

const GRANTED = 'session-granted';
const BYSTANDER = 'session-bystander';

afterEach(closeLaunchers);

async function approvePending(world: World): Promise<void> {
  const pending = (await world.ownerRequests()).filter(entry => entry.outcome === 'pending_owner');
  expect(pending).toHaveLength(1);
  const { requestHandle, revision } = pending[0]!;
  const decided = await call(world.origin, {
    method: 'POST', path: `/api/human/channel-access-requests/${requestHandle}/decision`, headers: world.owner,
    body: { v: 1, requestHandle, expectedRevision: revision, decision: 'approve', operationId: `decide-${requestHandle.slice(-8)}` },
  });
  expect(decided.status).toBe(200);
}

type Seeded = Readonly<{ world: World; pending: Canary; approved: Canary; operationId: string; capture: SurfaceCapture }>;

/** A granted session in the launch channel, an unbound bystander, and canaries on both sides. */
async function seeded(): Promise<Seeded> {
  const world = await launched();
  const pending = mintCanary('pending');
  const approved = mintCanary('approved');
  await world.say(world.other, `before ${pending.text}`);
  const [requested] = await world.serve(GRANTED, [['khala_request_channel_access', { target: `${world.origin}/channels/${encodeURIComponent(world.own)}` }]]);
  const operationId = (JSON.parse(requested!) as { result: { structuredContent: { operationId: string } } }).result.structuredContent.operationId;
  await approvePending(world);
  const [status] = await world.serve(GRANTED, [['khala_channel_access_status', { operationId }]]);
  expect(status).toContain('"outcome":"connected"');
  await world.say(world.own, `released ${approved.text}`);
  await world.say(world.other, `after ${pending.text}`);
  return { world, pending, approved, operationId, capture: createSurfaceCapture() };
}

function toolArguments(tool: string, seed: Seeded, sessionId: string): Record<string, unknown> {
  const other = `${seed.world.origin}/channels/${encodeURIComponent(seed.world.other)}`;
  switch (tool) {
    case 'khala_send': return { message: `probe from the Claude tool ${sessionId}` };
    case 'khala_request_channel_access': return { target: other };
    case 'khala_channel_access_status': return { operationId: seed.operationId };
    case 'khala_create_channel': return { title: 'Probe', operationId: 'create-13800000' };
    case 'khala_read': case 'khala_status': case 'khala_list_channels': case 'khala_list_agents': return {};
    default: throw new Error(`claude-session: no arguments defined for ${tool}; add a probe for it`);
  }
}

/** Drives every inventoried surface of the family for one session; returns the IDs driven. */
async function driveFamily(seed: Seeded, sessionId: string): Promise<string[]> {
  const listed = surfacesFor('claude-session');
  const tools = listed.filter(id => id.startsWith('claude-mcp-tool:')).map(id => id.slice('claude-mcp-tool:'.length));
  const ops = listed.filter(id => id.startsWith('claude-op:')).map(id => id.slice('claude-op:'.length));
  const routes = listed.filter(id => id.startsWith('http-internal:'));
  expect(routes).toEqual([`http-internal:POST ${CLAUDE_SESSION_PATH}`]);
  // `khala claude` is the command the ops run under; driving every op drives it.
  expect(listed).toContain('cli:claude');
  expect(listed.length).toBe(tools.length + ops.length + routes.length + 1);
  // Hooks first: `pull` never acknowledges, so the agent's own reads still see the release afterwards.
  for (const op of ops) seed.capture.add(`claude-op:${op} ${sessionId}`, await seed.world.op(sessionId, op, `probe from the Claude op ${sessionId}`));
  const results = await seed.world.serve(sessionId, tools.map(tool => [tool, toolArguments(tool, seed, sessionId)] as const));
  tools.forEach((tool, index) => seed.capture.add(`claude-mcp-tool:${tool} ${sessionId}`, results[index]!));
  // The route itself, with the session's own credential path covered above: the owner session and a forged bearer.
  const request = { v: 1, op: 'read', sessionId };
  const asOwner = await call(seed.world.origin, { method: 'POST', path: CLAUDE_SESSION_PATH, headers: seed.world.owner, body: request });
  expect(asOwner.status).toBe(403);
  const forged = await call(seed.world.origin, { method: 'POST', path: CLAUDE_SESSION_PATH, headers: { authorization: `Bearer ${'A'.repeat(42)}E` }, body: request });
  expect(forged.status).toBe(401);
  seed.capture.add(`http-internal:POST ${CLAUDE_SESSION_PATH} ${sessionId}`, asOwner.body + forged.body);
  return [...tools.map(tool => `claude-mcp-tool:${tool}`), ...ops.map(op => `claude-op:${op}`), ...routes, 'cli:claude'];
}

/** The owner's timeline of `channel`, as the owner's browser reads it. */
async function timeline(world: World, channel: string): Promise<string> {
  const read = await call(world.origin, { path: `/api/v1/channels/${encodeURIComponent(channel)}/timeline`, headers: world.owner });
  expect(read.status).toBe(200);
  return read.body;
}

describe('Claude session surfaces never carry content the session was not released', () => {
  it('claude-session: every Claude tool, op and the session route, for a granted and an unbound session', async () => {
    const seed = await seeded();
    const driven = await driveFamily(seed, GRANTED);
    await driveFamily(seed, BYSTANDER);
    expect(driven.sort()).toEqual([...surfacesFor('claude-session')].sort());
    // The launcher process's own output is a server log.
    seed.capture.add('launcher-output', seed.world.output());

    const leaks = seed.capture.leaks([seed.pending]);
    expect(leaks, describeLeaks(leaks)).toEqual([]);
    // The released message reaches the granted session's delivery surfaces and nothing else:
    // no send, status, mode or roster result, no bystander surface, and no server log.
    const delivering = ['claude-op:pull', 'claude-op:read', 'claude-mcp-tool:khala_read'].map(surface => `${surface} ${GRANTED}`);
    const carrying = seed.capture.carrying(seed.approved);
    expect(carrying.filter(where => !delivering.includes(where))).toEqual([]);
    // The hook pull runs first and delivers it; the agent's own read then acknowledges it.
    expect(carrying).toContain(`claude-op:pull ${GRANTED}`);
    const granted = (surface: string) => seed.capture.text(`${surface} ${GRANTED}`);
    // Every mode is labelled experimental: the default `sync` request needs the owner's
    // experimental-route grant, so nothing is effective and hooks deliver nothing.
    expect(granted('claude-op:hook')).toContain('"kind":"hook","effective":null');
    for (const surface of ['claude-op:mode', 'claude-mcp-tool:khala_status']) {
      const text = granted(surface).replaceAll('\\"', '"');
      expect(text, surface).toContain('"kind":"mode","requested":"sync","effective":null');
      expect(text, surface).toContain('"support":{"steer":"experimental","sync":"experimental","async":"experimental"}');
      expect(text, surface).toContain('"acknowledgement":"batch_token_next_call"');
    }
  });

  it('the granted binding is real: its sends reach its own channel only, and the bystander\'s reach nothing', async () => {
    const seed = await seeded();
    await driveFamily(seed, GRANTED);
    await driveFamily(seed, BYSTANDER);
    const own = await timeline(seed.world, seed.world.own);
    const other = await timeline(seed.world, seed.world.other);
    expect(own).toContain(`probe from the Claude tool ${GRANTED}`);
    expect(own).toContain(`probe from the Claude op ${GRANTED}`);
    expect(other).not.toContain('probe from the Claude');
    expect(own + other).not.toContain(BYSTANDER);
    expect(seed.capture.text(`claude-mcp-tool:khala_list_agents ${GRANTED}`)).toContain('"ownerDisplayName":"Owner"');
  });
});
