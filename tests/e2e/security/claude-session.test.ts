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
// In this build the Claude adapter refuses every `pull` and `read` as `unproven`: no
// acknowledgement route is proven, and the listening-mode store internal mode composes
// holds no requested mode for Claude, whose routes are all unproven, so no mode is
// effective (#382, #392, `composition/claude-session/compose.ts`). So no message body
// reaches a Claude session at all, and the approved canary cannot serve as a positive control. The
// suite asserts that refusal exactly: the day reads are enabled it fails, and the
// approved-canary control must be switched on here. Until then the proof that the
// probes reached a real binding is that the granted session's own sends land in its
// channel, and only there.

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

    const leaks = seed.capture.leaks([seed.pending, seed.approved]);
    expect(leaks, describeLeaks(leaks)).toEqual([]);
    // Why the approved canary is absent too: reads are refused, not filtered.
    const granted = (surface: string) => seed.capture.text(`${surface} ${GRANTED}`);
    for (const surface of ['claude-op:pull', 'claude-op:read', 'claude-mcp-tool:khala_read']) {
      expect(granted(surface), surface).toContain('"code":"unproven"');
    }
    // The mode is read from the composed store, but Claude has no evidenced mode: nothing is
    // requested, nothing is effective, and hooks therefore deliver nothing.
    expect(granted('claude-op:hook')).toContain('"kind":"hook","effective":null');
    for (const surface of ['claude-op:mode', 'claude-mcp-tool:khala_status']) {
      const text = granted(surface).replaceAll('\\"', '"');
      expect(text, surface).toContain('"kind":"mode","requested":null,"effective":null');
      expect(text, surface).toContain('"support":{"steer":"unproven","sync":"unproven","async":"unproven"}');
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
