import fs from 'node:fs';
import { type HarnessCapabilities, decodeDeliveryLimits } from '@khala/contracts/delivery/index';
import {
  CLAUDE_INTERACTIVE_EVIDENCE_REVISION, CLAUDE_INTERACTIVE_ROUTE, installedClaudeCapabilities,
} from '@khala/harnesses/claude/interactive';
import { afterEach, describe, expect, it } from 'vitest';
import { composeBindingControl } from '../composition/binding-control/index';
import { composeBindingModes } from '../composition/binding-modes/index';
import { createBindingPauseStore } from '../store/pause-store';
import { startChannelServer } from './channel-server';
import { alice, bobBinding, carolBinding, channelId, createChannelFixture, type ChannelFixture } from './fixtures/channel-fixture';
import type { LoopbackServer } from './server';

const NOW = Date.parse('2026-09-25T00:00:00.000Z');
const ISSUED = new Date(NOW).toISOString();
const cleanups: (() => Promise<void> | void)[] = [];
/** The server's clock; a test may move it between a command and its retry. */
const time = { now: NOW };

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  time.now = NOW;
});

type Harness = Readonly<{ fixture: ChannelFixture; server: LoopbackServer }>;

/** `claim`, when given, is the harness claim every binding is projected through, as a launcher's inspection supplies it. */
async function start(claim?: HarnessCapabilities): Promise<Harness> {
  const fixture = createChannelFixture({ root: fs.mkdtempSync('/tmp/khala-modes-'), now: NOW });
  cleanups.push(() => fixture.dispose());
  const composed = composeBindingModes({ handle: fixture.handle, store: fixture.store });
  const modes = claim === undefined ? composed : { ...composed, control: { ...composed.control, capabilities: () => claim } };
  let id = 0;
  const server = await startChannelServer({
    store: fixture.store,
    bootstrap: [fixture.bootstrap],
    bindings: [fixture.bob, fixture.carol],
    releases: modes.releases,
    bindingModes: modes.control,
    stop: composeBindingControl({ handle: fixture.handle, root: fixture.root }),
    newId: () => `id-${++id}`,
    clock: () => time.now,
    startPort: 0,
  });
  cleanups.push(() => server.close());
  return { fixture, server };
}

type Reply = Readonly<{ status: number; json: any }>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(h: Harness, path: string, init: Readonly<{ method?: string; headers?: Record<string, string>; body?: unknown }> = {}) {
  const response = await fetch(`${h.server.origin}${path}`, {
    method: init.method ?? 'GET',
    headers: { ...init.headers, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* Not JSON. */ }
  return { status: response.status, json } as Reply;
}

async function human(h: Harness): Promise<Record<string, string>> {
  const response = await fetch(`${h.server.origin}/__khala/session`, {
    method: 'POST',
    headers: { origin: h.server.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ credential: h.fixture.bootstrap.credential, channelId }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.getSetCookie()[0]!.split(';')[0]!;
  const { requestSecret } = await response.json() as { requestSecret: string };
  return { cookie, 'x-khala-request-secret': requestSecret, origin: h.server.origin };
}

const bearer = (credential: string) => ({ authorization: `Bearer ${credential}` });
const OWNER_MODE = `/api/v1/channels/${channelId}/bindings/${bobBinding.bindingId}/listening-mode`;
const OWNER_PAUSE = `/api/v1/channels/${channelId}/bindings/${bobBinding.bindingId}/pause`;
const AGENT_MODE = '/api/v1/agent/listening-mode';
const RELEASES = `/api/v1/channels/${channelId}/releases`;

async function say(h: Harness, owner: Record<string, string>, body: string): Promise<string> {
  const reply = await call(h, `/api/v1/channels/${channelId}/messages`, {
    method: 'POST', headers: owner, body: { clientTxnId: `txn-${body.replaceAll(' ', '-')}`, content: { v: 1, kind: 'text', body } },
  });
  expect(reply.status).toBe(201);
  return reply.json.event.eventId;
}

describe('binding listening-mode control', () => {
  it('starts in sync; the server claims no Codex route it cannot inspect', async () => {
    const h = await start();
    const owner = await human(h);
    const read = await call(h, OWNER_MODE, { headers: owner });
    expect(read.status).toBe(200);
    expect(read.json).toMatchObject({
      v: 1, paused: false,
      view: { bindingId: bobBinding.bindingId, generation: 1, requested: 'sync', version: 1, effective: null, effectiveReason: 'capabilities_unavailable' },
    });
    const agent = await call(h, AGENT_MODE, { headers: bearer(h.fixture.bob.credential) });
    expect(agent.status).toBe(200);
    expect(agent.json.binding).toEqual(bobBinding);
    expect(agent.json.view).toMatchObject({ requested: 'sync', version: 1 });
  });

  it('owner and agent writes share one versioned record and record who changed it', async () => {
    const h = await start();
    const owner = await human(h);
    await call(h, OWNER_MODE, { headers: owner });
    const ownerSet = await call(h, OWNER_MODE, {
      method: 'POST', headers: owner, body: { v: 1, commandId: 'owner-1', generation: 1, expectedVersion: 1, requested: 'steer', issuedAt: ISSUED },
    });
    expect(ownerSet.json).toMatchObject({ outcome: 'applied', requested: 'steer', version: 2 });
    const seen = await call(h, AGENT_MODE, { headers: bearer(h.fixture.bob.credential) });
    expect(seen.json.view).toMatchObject({ requested: 'steer', version: 2, lastChangedBy: { kind: 'owner', participantId: alice.ownerId } });

    const agentSet = await call(h, AGENT_MODE, {
      method: 'POST', headers: bearer(h.fixture.bob.credential),
      body: { v: 1, commandId: 'agent-1', expectedVersion: 2, requested: 'async', issuedAt: new Date(NOW).toISOString() },
    });
    expect(agentSet.json).toMatchObject({ outcome: 'applied', requested: 'async', version: 3, bindingId: bobBinding.bindingId });
    const after = await call(h, OWNER_MODE, { headers: owner });
    expect(after.json.view).toMatchObject({ requested: 'async', version: 3, lastChangedBy: { kind: 'agent', participantId: bobBinding.agentParticipantId } });

    // A stale version conflicts and changes nothing; a retried command replays its first answer.
    const stale = await call(h, OWNER_MODE, {
      method: 'POST', headers: owner, body: { v: 1, commandId: 'owner-2', generation: 1, expectedVersion: 1, requested: 'sync', issuedAt: ISSUED },
    });
    expect(stale.json).toMatchObject({ outcome: 'conflict', requested: 'async', version: 3 });
    // An owner retry after the server clock moved on replays its first answer; it is never a new command.
    time.now += 60_000;
    const ownerReplay = await call(h, OWNER_MODE, {
      method: 'POST', headers: owner, body: { v: 1, commandId: 'owner-1', generation: 1, expectedVersion: 1, requested: 'steer', issuedAt: ISSUED },
    });
    expect(ownerReplay.json).toMatchObject({ outcome: 'applied', requested: 'steer', version: 2 });
    const replay = await call(h, AGENT_MODE, {
      method: 'POST', headers: bearer(h.fixture.bob.credential),
      body: { v: 1, commandId: 'agent-1', expectedVersion: 2, requested: 'async', issuedAt: new Date(NOW).toISOString() },
    });
    expect(replay.json).toMatchObject({ outcome: 'applied', version: 3 });
  });

  it('async releases never wake; the mode decides only the wake hint', async () => {
    const h = await start();
    const owner = await human(h);
    await call(h, OWNER_MODE, { headers: owner });
    await call(h, OWNER_MODE, {
      method: 'POST', headers: owner, body: { v: 1, commandId: 'owner-async', generation: 1, expectedVersion: 1, requested: 'async', issuedAt: ISSUED },
    });
    await say(h, owner, 'quietly');
    const page = await call(h, RELEASES, { headers: bearer(h.fixture.bob.credential) });
    expect(page.json.releases.map((release: { wake: boolean }) => release.wake)).toEqual([false]);
  });

  it('refuses a wrong principal, an unknown binding, another channel\'s binding and a malformed command', async () => {
    const h = await start();
    const owner = await human(h);
    expect((await call(h, OWNER_MODE, { headers: bearer(h.fixture.bob.credential) })).status).toBe(403);
    expect((await call(h, OWNER_PAUSE, { method: 'POST', headers: bearer(h.fixture.bob.credential), body: { v: 1, generation: 1, paused: true } })).status).toBe(403);
    expect((await call(h, AGENT_MODE, { headers: owner })).status).toBe(403);
    expect((await call(h, `/api/v1/channels/${channelId}/bindings/binding-nobody/listening-mode`, { headers: owner })).status).toBe(404);
    // Carol is bound to the other channel only.
    expect((await call(h, `/api/v1/channels/${channelId}/bindings/${carolBinding.bindingId}/listening-mode`, { headers: owner })).status).toBe(404);
    for (const body of [
      { v: 1, commandId: 'x', generation: 1, expectedVersion: 1, requested: 'loud', issuedAt: ISSUED },
      { v: 1, commandId: 'x', generation: 1, expectedVersion: 1, requested: 'sync', issuedAt: ISSUED, bindingId: carolBinding.bindingId },
      { v: 1, commandId: 'x', expectedVersion: 1, requested: 'sync' },
      { v: 1, commandId: 'x', generation: 1, expectedVersion: 1, requested: 'sync' },
      { v: 1, commandId: 'x', generation: 1, expectedVersion: 1, requested: 'sync', issuedAt: 'a\nb' },
    ]) {
      expect((await call(h, OWNER_MODE, { method: 'POST', headers: owner, body })).status).toBe(400);
    }
    // An agent cannot name a target: its own capability is the only binding it may change.
    expect((await call(h, AGENT_MODE, {
      method: 'POST', headers: bearer(h.fixture.bob.credential),
      body: { v: 1, commandId: 'y', expectedVersion: 1, requested: 'sync', issuedAt: 'now', bindingId: carolBinding.bindingId },
    })).status).toBe(400);
  });
});

describe('owner experimental-route grant', () => {
  const limits = decodeDeliveryLimits({ maxPayloadBytes: 65_536, maxSelectionEvents: 32 });
  if (!limits.ok) throw new Error('invalid test limits');
  /** An inspected Claude Code that is not in the proven list: every mode is experimental. */
  const EXPERIMENTAL_VERSION = '2.1.283';
  const experimental = installedClaudeCapabilities(EXPERIMENTAL_VERSION, limits.value);
  const GRANT = `/api/v1/channels/${channelId}/bindings/${bobBinding.bindingId}/experimental-route/grant`;
  const REVOKE = `/api/v1/channels/${channelId}/bindings/${bobBinding.bindingId}/experimental-route/revoke`;
  /** The exact route, tested version and evidence revision the owner reviewed for `mode`. */
  const pinFor = (mode: 'steer' | 'sync') =>
    ({ mode, route: `${CLAUDE_INTERACTIVE_ROUTE}-${mode}`, harnessVersion: EXPERIMENTAL_VERSION, evidenceRevision: CLAUDE_INTERACTIVE_EVIDENCE_REVISION });
  const pin = pinFor('steer');
  const command = (commandId: string, expectedVersion: number, overrides: Record<string, unknown> = {}) =>
    ({ v: 1, commandId, generation: 1, expectedVersion, ...pin, issuedAt: ISSUED, ...overrides });

  it('makes a requested experimental mode effective only while the owner\'s pinned grant holds', async () => {
    const h = await start(experimental);
    const owner = await human(h);
    await call(h, OWNER_MODE, {
      method: 'POST', headers: owner, body: { v: 1, commandId: 'steer-1', generation: 1, expectedVersion: 1, requested: 'steer', issuedAt: ISSUED },
    });
    const before = await call(h, OWNER_MODE, { headers: owner });
    expect(before.json.view).toMatchObject({
      requested: 'steer', version: 2, effective: null, effectiveReason: 'experimental_grant_required',
      support: { steer: { status: 'experimental', route: pin.route, testedVersion: pin.harnessVersion, evidenceRevision: pin.evidenceRevision } },
    });

    const granted = await call(h, GRANT, { method: 'POST', headers: owner, body: command('grant-1', 2) });
    expect(granted.status).toBe(200);
    expect(granted.json).toMatchObject({
      v: 1, commandId: 'grant-1', bindingId: bobBinding.bindingId, generation: 1, outcome: 'applied', reason: null,
      view: { effective: 'steer', version: 3, lastChangedBy: { kind: 'owner', participantId: alice.ownerId } },
    });
    expect(granted.json.view.experimentalGrants).toEqual([{ v: 1, kind: 'experimental_route', bindingId: bobBinding.bindingId, generation: 1, ...pin, grantRevision: 3 }]);
    // The owner's list carries the grant, so the panel can show it and offer its revoke.
    const listed = await call(h, `/api/v1/channels/${channelId}/bindings`, { headers: owner });
    expect(listed.json.bindings[0].view).toMatchObject({ effective: 'steer', experimentalGrants: [{ mode: 'steer' }] });
    // A retried grant replays its first answer; a stale version conflicts and grants nothing new.
    expect((await call(h, GRANT, { method: 'POST', headers: owner, body: command('grant-1', 2) })).json).toMatchObject({ outcome: 'applied', view: { version: 3 } });
    expect((await call(h, GRANT, { method: 'POST', headers: owner, body: command('grant-2', 2, pinFor('sync')) })).json)
      .toMatchObject({ outcome: 'conflict', reason: 'stale_version', view: { version: 3 } });

    const revoked = await call(h, REVOKE, { method: 'POST', headers: owner, body: command('revoke-1', 3) });
    expect(revoked.json).toMatchObject({ outcome: 'applied', view: { effective: null, effectiveReason: 'experimental_grant_required', experimentalGrants: [], version: 4 } });
  });

  it('refuses a grant pinned to evidence the binding no longer claims, and an unproven harness', async () => {
    const h = await start(experimental);
    const owner = await human(h);
    for (const stale of [{ evidenceRevision: 'older-revision' }, { harnessVersion: '2.1.200' }, { route: 'claude-other-route' }]) {
      expect((await call(h, GRANT, { method: 'POST', headers: owner, body: command(`stale-${Object.keys(stale)[0]}`, 1, stale) })).json)
        .toEqual({ v: 1, commandId: `stale-${Object.keys(stale)[0]}`, bindingId: bobBinding.bindingId, generation: 1, outcome: 'refused', reason: 'capability_mismatch' });
    }
    expect((await call(h, OWNER_MODE, { headers: owner })).json.view.experimentalGrants).toEqual([]);

    // Without an inspected harness claim there is no experimental route to grant.
    const unproven = await start();
    const unprovenOwner = await human(unproven);
    expect((await call(unproven, GRANT, { method: 'POST', headers: unprovenOwner, body: command('none-1', 1) })).json)
      .toMatchObject({ outcome: 'refused', reason: 'capability_mismatch' });
  });

  it('admits only the human owner, with an exact command naming the generation they saw', async () => {
    const h = await start(experimental);
    const owner = await human(h);
    // A bound agent can never grant itself a route, nor revoke one.
    expect((await call(h, GRANT, { method: 'POST', headers: bearer(h.fixture.bob.credential), body: command('agent-1', 1) })).status).toBe(403);
    expect((await call(h, REVOKE, { method: 'POST', headers: bearer(h.fixture.bob.credential), body: command('agent-2', 1) })).status).toBe(403);
    // The request secret is required beside the session cookie.
    const cookieOnly = Object.fromEntries(Object.entries(owner).filter(([name]) => name !== 'x-khala-request-secret'));
    expect((await call(h, GRANT, { method: 'POST', headers: cookieOnly, body: command('cookie-1', 1) })).status).not.toBe(200);
    for (const body of [
      command('bad-1', 1, { mode: 'loud' }),
      command('bad-2', 1, { bindingId: carolBinding.bindingId }),
      command('bad-3', 1, { issuedAt: 'a\nb' }),
      command('bad-4', 1, { route: '' }),
      { ...command('bad-5', 1), harnessVersion: undefined },
    ]) expect((await call(h, GRANT, { method: 'POST', headers: owner, body })).status).toBe(400);
    expect((await call(h, GRANT, { method: 'POST', headers: owner, body: command('gen-1', 1, { generation: 2 }) })).json)
      .toMatchObject({ outcome: 'refused', reason: 'stale_binding' });
    expect((await call(h, OWNER_MODE, { headers: owner })).json.view).toMatchObject({ version: 1, experimentalGrants: [] });
  });

  it('Stop revokes the grant with the binding: nothing is left to grant, revoke or deliver', async () => {
    const h = await start(experimental);
    const owner = await human(h);
    await call(h, OWNER_MODE, {
      method: 'POST', headers: owner, body: { v: 1, commandId: 'steer-1', generation: 1, expectedVersion: 1, requested: 'steer', issuedAt: ISSUED },
    });
    expect((await call(h, GRANT, { method: 'POST', headers: owner, body: command('grant-1', 2) })).json.outcome).toBe('applied');
    const stopped = await call(h, `/api/v1/channels/${channelId}/stop`, { method: 'POST', headers: owner, body: { v: 1, targets: null } });
    expect(stopped.json.outcome).toBe('stopped');
    expect((await call(h, GRANT, { method: 'POST', headers: owner, body: command('grant-2', 3) })).status).toBe(404);
    expect((await call(h, REVOKE, { method: 'POST', headers: owner, body: command('revoke-1', 3) })).status).toBe(404);
    expect((await call(h, `/api/v1/channels/${channelId}/bindings`, { headers: owner })).json.bindings).toEqual([]);
    // The stopped binding's own capability no longer reaches its mode or its releases.
    expect((await call(h, AGENT_MODE, { headers: bearer(h.fixture.bob.credential) })).status).toBe(401);
    expect((await call(h, RELEASES, { headers: bearer(h.fixture.bob.credential) })).status).toBe(401);
  });
});

describe('owner binding list and the agent\'s harness report', () => {
  it('lists only the channel\'s live bindings, with mode, pause and the agent\'s name', async () => {
    const h = await start();
    const owner = await human(h);
    const listed = await call(h, `/api/v1/channels/${channelId}/bindings`, { headers: owner });
    expect(listed.status).toBe(200);
    // Carol is bound to the other channel only.
    expect(listed.json.bindings.map((entry: { binding: { bindingId: string } }) => entry.binding.bindingId)).toEqual([bobBinding.bindingId]);
    expect(listed.json.bindings[0]).toMatchObject({
      displayName: 'Bob', paused: false, idleDelivery: 'unproven', binding: bobBinding, harnessVersion: null, ownedByViewer: true,
      view: { requested: 'sync', effective: null, effectiveReason: 'capabilities_unavailable', lastChangedBy: { kind: 'unknown' } },
    });
    expect((await call(h, `/api/v1/channels/${channelId}/bindings`, { headers: bearer(h.fixture.bob.credential) })).status).toBe(403);
    await call(h, `/api/v1/channels/${channelId}/stop`, { method: 'POST', headers: owner, body: { v: 1, targets: null } });
    expect((await call(h, `/api/v1/channels/${channelId}/bindings`, { headers: owner })).json.bindings).toEqual([]);
  });

  it('derives the owner\'s view from the released claim for what the agent observed, and never claims more', async () => {
    const h = await start();
    const owner = await human(h);
    const report = (body: unknown, headers: Record<string, string> = bearer(h.fixture.bob.credential)) =>
      call(h, '/api/v1/agent/harness', { method: 'POST', headers, body });
    const view = async () => (await call(h, OWNER_MODE, { headers: owner })).json.view;

    expect((await report({ v: 1, version: '0.156.1', hookReview: 'trusted' })).status).toBe(200);
    expect(await view()).toMatchObject({ requested: 'sync', effective: 'sync', support: { sync: { status: 'proven' }, async: { status: 'unknown' } } });
    // The owner's list labels the agent with the version it reported.
    expect((await call(h, `/api/v1/channels/${channelId}/bindings`, { headers: owner })).json.bindings[0].harnessVersion).toBe('0.156.1');
    // Untrusted hooks or an unproven version claim nothing, whatever mode was requested.
    await report({ v: 1, version: '0.156.1', hookReview: 'awaiting_hook_review' });
    expect(await view()).toMatchObject({ effective: null, effectiveReason: 'support_unknown' });
    await report({ v: 1, version: '0.1.0', hookReview: 'trusted' });
    expect(await view()).toMatchObject({ effective: null, effectiveReason: 'support_unknown' });

    for (const body of [
      { v: 1, version: '0.156.1', hookReview: 'yes' },
      { v: 1, version: 'bad version', hookReview: 'trusted' },
      { v: 1, version: '0.156.1', hookReview: 'trusted', bindingId: carolBinding.bindingId },
    ]) expect((await report(body)).status).toBe(400);
    expect((await report({ v: 1, version: '0.156.1', hookReview: 'trusted' }, owner)).status).toBe(403);
  });
});

describe('binding pause', () => {
  it('holds every release before any claim, and resume releases the held work in order', async () => {
    const h = await start();
    const owner = await human(h);
    const paused = await call(h, OWNER_PAUSE, { method: 'POST', headers: owner, body: { v: 1, generation: 1, paused: true } });
    expect(paused.json).toEqual({ v: 1, bindingId: bobBinding.bindingId, generation: 1, paused: true });
    expect((await call(h, OWNER_MODE, { headers: owner })).json.paused).toBe(true);
    const first = await say(h, owner, 'first while paused');
    const second = await say(h, owner, 'second while paused');
    const held = await call(h, RELEASES, { headers: bearer(h.fixture.bob.credential) });
    expect(held.json).toMatchObject({ releases: [], held: 'paused', nextCursor: null });

    await call(h, OWNER_PAUSE, { method: 'POST', headers: owner, body: { v: 1, generation: 1, paused: false } });
    const released = await call(h, RELEASES, { headers: bearer(h.fixture.bob.credential) });
    expect(released.json.held).toBeNull();
    expect(released.json.releases.map((release: { events: { eventId: string }[] }) => release.events[0]!.eventId)).toEqual([first, second]);
  });

  it('names the exact generation the owner saw, and a stopped binding has nothing to pause', async () => {
    const h = await start();
    const owner = await human(h);
    expect((await call(h, OWNER_PAUSE, { method: 'POST', headers: owner, body: { v: 1, generation: 2, paused: true } })).status).toBe(409);
    expect((await call(h, OWNER_PAUSE, { method: 'POST', headers: owner, body: { v: 1, generation: 1, paused: 'yes' } })).status).toBe(400);
    const stopped = await call(h, `/api/v1/channels/${channelId}/stop`, { method: 'POST', headers: owner, body: { v: 1, targets: null } });
    expect(stopped.json.outcome).toBe('stopped');
    expect((await call(h, OWNER_PAUSE, { method: 'POST', headers: owner, body: { v: 1, generation: 1, paused: true } })).status).toBe(404);
    expect((await call(h, OWNER_MODE, { headers: owner })).status).toBe(404);
    expect((await call(h, AGENT_MODE, { headers: bearer(h.fixture.bob.credential) })).status).toBe(401);
  });

  it('is durable per generation and fails closed on a record it cannot read', async () => {
    const h = await start();
    const pause = createBindingPauseStore(h.fixture.handle);
    expect(pause.read(bobBinding)).toBe(false);
    expect(pause.set(bobBinding, true)).toEqual({ kind: 'done', paused: true });
    // A pause names one generation: the next generation starts unpaused.
    expect(pause.read({ ...bobBinding, generation: 2 })).toBe(false);
    expect(createBindingPauseStore(h.fixture.handle).read(bobBinding)).toBe(true);
    h.fixture.handle.transaction(db => db.prepare("UPDATE control_records SET value = '{\"paused\":\"maybe\"}'").run());
    expect(pause.read(bobBinding)).toBe('unavailable');
    const feed = await call(h, RELEASES, { headers: bearer(h.fixture.bob.credential) });
    expect(feed.status).toBe(503);
  });
});
