import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ListeningModeView, SessionBinding } from '@khala/contracts/delivery/index';
import type { DeviceId, EventId, ParticipantId, RoomId } from '@khala/contracts/messaging/index';
import { LOCAL_AUTOMATION_LIMITS } from '@khala/policy/listening-mode/limits';
import { createChannelStore, type StoredEvent } from '../../store/channel-store';
import { createDiscoveryStore } from '../../store/discovery-store';
import { createAgentAcknowledgementLedger } from '../../store/acknowledgements';
import { openChannelStore } from '../../store/open';
import { createSqliteListeningModeRepository } from '../../listening-mode-store/sqlite';
import { createBindingPauseStore } from '../../store/pause-store';
import { internalReleaseId } from '../../store/release-id';
import { createLocalAutomationProvider } from './provider';
import { createLocalAutomationLedger } from './ledger';
import { composeBindingModes } from '../binding-modes/index';
import { createCodexIdleActivity } from '@aiur/khala/composition/codex-idle-activity';
import { internalSessionDigest } from '@aiur/khala/composition/internal-session';
import { startChannelServer } from '../../server/channel-server';
import { mintCredential } from '../../server/credentials';
import { composeBindingControl } from '../binding-control/index';

const room = 'channel-peer' as RoomId;
const human = 'human-one' as ParticipantId;
const humanDevice = 'human-device' as DeviceId;
const bob = { v: 1, bindingId: 'binding-bob', ownerId: 'owner-one', agentParticipantId: 'agent-bob',
  deviceId: 'device-bob', harness: 'codex', sessionId: internalSessionDigest('codex', 'bob-thread'), generation: 1 } as SessionBinding;
const carol = { ...bob, bindingId: 'binding-carol', agentParticipantId: 'agent-carol',
  deviceId: 'device-carol', sessionId: internalSessionDigest('codex', 'carol-thread') } as SessionBinding;
const idleEpoch = '11111111-1111-4111-8111-111111111111';
const endedEpoch = '22222222-2222-4222-8222-222222222222';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function world() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-local-peer-'));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  const handle = openChannelStore({ directory: path.join(root, 'state'), mode: 'create' });
  const store = createChannelStore(handle);
  const discovery = createDiscoveryStore(handle);
  const acknowledgements = createAgentAcknowledgementLedger(handle);
  const modes = createSqliteListeningModeRepository(handle);
  store.registerParticipant({ participantId: human, ownerId: 'owner-one' as never, kind: 'human', displayName: 'Human' });
  for (const binding of [bob, carol]) {
    store.registerParticipant({ participantId: binding.agentParticipantId, ownerId: binding.ownerId,
      kind: 'agent', displayName: binding.agentParticipantId });
    store.registerDevice({ deviceId: binding.deviceId, participantId: binding.agentParticipantId });
  }
  store.registerDevice({ deviceId: humanDevice, participantId: human });
  expect(store.createChannel({ operationId: 'create-peer-channel', channelId: room, title: 'Peer channel',
    creatorOwnerId: bob.ownerId, creatorParticipantId: human, creatorDeviceId: humanDevice,
    createdAt: '2026-09-27T00:00:00.000Z' })).toMatchObject({ kind: 'created' });
  for (const binding of [bob, carol]) {
    store.setMembership({ channelId: room, participantId: binding.agentParticipantId, membership: 'joined' });
    expect(discovery.activate({ operationKey: `grant-${binding.bindingId}`, binding, channelId: room,
      sessionGeneration: 1, history: 'shared' })).toMatchObject({ kind: 'activated' });
    expect(modes.initialize({ bindingId: binding.bindingId, generation: binding.generation,
      requested: 'sync', version: 1, experimentalGrants: [], hardCancelGrants: [],
      lastChangedBy: { kind: 'unknown' } })).toBe(true);
  }
  let next = 0;
  const send = (author: 'human' | 'bob' | 'carol', sourceBinding?: SessionBinding): StoredEvent => {
    next += 1;
    const binding = author === 'bob' ? bob : author === 'carol' ? carol : null;
    const result = store.send({ channelId: room, eventId: `event-${next}` as EventId,
      authorParticipantId: binding?.agentParticipantId ?? human,
      authorDeviceId: binding?.deviceId ?? humanDevice,
      clientTxnId: `txn-${next}`, content: { v: 1, kind: 'text', body: `message ${next}` },
      receivedAt: '2026-09-27T00:00:01.000Z', ...(sourceBinding ? { sourceBinding } : {}) });
    expect(result.kind).toBe('stored');
    if (result.kind !== 'stored') throw new Error('send was not stored');
    return result.event;
  };
  const acknowledge = (recipient: SessionBinding, event: StoredEvent) => {
    const principal = { bindingId: recipient.bindingId, generation: recipient.generation };
    const release = { releaseId: internalReleaseId(recipient, event.eventId), eventIds: [event.eventId] };
    const proof = acknowledgements.issueRelease({ principal, channelId: room, release });
    const token = acknowledgements.issueBatch({ principal, channelId: room, releases: [{ ...release, proof }] });
    expect(token).not.toBeNull();
    expect(acknowledgements.recordBatchAcknowledgement({ principal, channelId: room, token: token!, releases: [release] }))
      .toMatchObject({ kind: 'recorded' });
  };
  const ledger = createLocalAutomationLedger(handle, createLocalAutomationProvider(LOCAL_AUTOMATION_LIMITS));
  const mode = (recipient: SessionBinding): ListeningModeView => ({ bindingId: recipient.bindingId,
    generation: recipient.generation, version: 1, requested: 'sync', effective: 'sync' } as ListeningModeView);
  return { handle, store, ledger, send, acknowledge, mode, root };
}

describe('durable local peer reservation', () => {
  it('carries human-root provenance through acknowledged agent sends and bounds a two-agent loop', () => {
    const w = world();
    try {
      const root = w.send('human');
      w.acknowledge(bob, root);
      const first = w.send('bob', bob);
      expect(w.ledger.reserve({ recipient: carol, event: first, mode: w.mode(carol) })).toMatchObject({
        kind: 'reserved', rootId: root.eventId, depth: 1,
      });
      expect(w.ledger.reserve({ recipient: carol, event: first, mode: w.mode(carol) })).toMatchObject({ kind: 'duplicate' });
      w.acknowledge(carol, first);
      const competing = w.send('bob', bob);
      expect(w.ledger.reserve({ recipient: carol, event: competing, mode: w.mode(carol) }))
        .toEqual({ kind: 'held', reason: 'busy' });
      const second = w.send('carol', carol);
      // A causally linked, authenticated reply is a terminal observation. ACK alone
      // did not free the slot, and another root never inherits its budget.
      expect(w.ledger.reserve({ recipient: bob, event: second, mode: w.mode(bob) })).toMatchObject({
        kind: 'reserved', rootId: root.eventId, depth: 2,
      });
      w.acknowledge(bob, second);
      const third = w.send('bob', bob);
      expect(w.ledger.reserve({ recipient: carol, event: third, mode: w.mode(carol) })).toEqual({ kind: 'held', reason: 'loop_limit' });
    } finally { w.handle.close(); }
  });

  it('does not trust an agent send with no current acknowledged batch or caller-supplied source', () => {
    const w = world();
    try {
      const unsupported = w.send('bob');
      expect(w.ledger.reserve({ recipient: carol, event: unsupported, mode: w.mode(carol) }))
        .toEqual({ kind: 'held', reason: 'causal_unknown' });
      const forged = w.send('bob', carol);
      expect(w.ledger.reserve({ recipient: carol, event: forged, mode: w.mode(carol) }))
        .toEqual({ kind: 'held', reason: 'causal_unknown' });
    } finally { w.handle.close(); }
  });

  it('rechecks pause, mode revision, admission and Stop against the same durable claim', () => {
    const w = world();
    try {
      const root = w.send('human');
      w.acknowledge(bob, root);
      const first = w.send('bob', bob);
      const pause = createBindingPauseStore(w.handle);
      expect(pause.set(carol, true)).toEqual({ kind: 'done', paused: true });
      expect(w.ledger.reserve({ recipient: carol, event: first, mode: w.mode(carol) }))
        .toEqual({ kind: 'held', reason: 'paused' });
      expect(pause.set(carol, false)).toEqual({ kind: 'done', paused: false });
      w.handle.transaction(db => db.prepare('UPDATE mode_controls SET version = 2 WHERE binding_id = ?')
        .run(carol.bindingId));
      expect(w.ledger.reserve({ recipient: carol, event: first, mode: { ...w.mode(carol), version: 2 } }))
        .toEqual({ kind: 'held', reason: 'stale' });
      w.handle.transaction(db => db.prepare('UPDATE mode_controls SET version = 1 WHERE binding_id = ?')
        .run(carol.bindingId));
      expect(w.ledger.reserve({ recipient: carol, event: first, mode: w.mode(carol) })).toMatchObject({ kind: 'reserved' });
      expect(w.store.revokeBinding({ bindingId: carol.bindingId, generation: carol.generation })).toMatchObject({ kind: 'done' });
      expect(w.ledger.reserve({ recipient: carol, event: first, mode: w.mode(carol) }))
        .toEqual({ kind: 'held', reason: 'grant' });
      expect(w.ledger.finishEnded({ recipient: carol, channelId: room, epoch: endedEpoch })).toBe(0);
    } finally { w.handle.close(); }
  });

  it('keeps an unpulled no-send job active until an exact live turn-end follows an issued release', () => {
    const w = world();
    try {
      const root = w.send('human');
      w.acknowledge(bob, root);
      const principal = { bindingId: carol.bindingId, generation: carol.generation };
      const humanRelease = { releaseId: internalReleaseId(carol, root.eventId), eventIds: [root.eventId] };
      const humanProof = createAgentAcknowledgementLedger(w.handle).issueRelease({ principal, channelId: room,
        release: humanRelease });
      const oldToken = createAgentAcknowledgementLedger(w.handle).issueBatch({ principal, channelId: room,
        releases: [{ ...humanRelease, proof: humanProof }] });
      expect(oldToken).not.toBeNull();
      const first = w.send('bob', bob);
      expect(w.ledger.reserve({ recipient: carol, event: first, mode: w.mode(carol), claimedIdleEpoch: idleEpoch }))
        .toMatchObject({ kind: 'reserved' });
      expect(w.ledger.finishEnded({ recipient: carol, channelId: room, epoch: idleEpoch })).toBe(0);
      const later = w.send('bob', bob);
      expect(w.ledger.reserve({ recipient: carol, event: later, mode: w.mode(carol) }))
        .toEqual({ kind: 'held', reason: 'busy' });
      w.acknowledge(carol, first);
      expect(w.ledger.reserve({ recipient: carol, event: later, mode: w.mode(carol) }))
        .toEqual({ kind: 'held', reason: 'busy' });
      expect(w.ledger.finishEnded({ recipient: { ...carol, generation: 2 }, channelId: room, epoch: endedEpoch })).toBe(0);
      expect(w.ledger.finishEnded({ recipient: carol, channelId: 'other-channel', epoch: endedEpoch })).toBe(0);
      expect(w.ledger.finishEnded({ recipient: carol, channelId: room, epoch: idleEpoch })).toBe(0);
      expect(w.ledger.finishEnded({ recipient: carol, channelId: room, epoch: endedEpoch,
        batchToken: oldToken })).toBe(0);
      const actualEnd = '33333333-3333-4333-8333-333333333333';
      const peerToken = w.handle.read(db => db.prepare(`SELECT token FROM issued_agent_batch_members
        WHERE binding_id = ? AND generation = ? AND release_id = ?`)
        .get(carol.bindingId, carol.generation, internalReleaseId(carol, first.eventId)) as { token: string });
      expect(w.ledger.finishEnded({ recipient: carol, channelId: room, epoch: actualEnd,
        batchToken: peerToken.token })).toBe(1);
      expect(w.ledger.finishEnded({ recipient: carol, channelId: room, epoch: endedEpoch })).toBe(0);
      expect(w.ledger.reserve({ recipient: carol, event: later, mode: w.mode(carol) })).toMatchObject({ kind: 'reserved' });
    } finally { w.handle.close(); }
  });

  it('composes a real two-agent SQLite pull and native notice from server-derived peer authority', async () => {
    const w = world();
    try {
      const queued: string[][] = [];
      const composed = composeBindingModes({ handle: w.handle, store: w.store, stateDirectory: w.root,
        codexWake: { inspect: async () => ({ version: '0.154.0', hookReview: 'trusted' }),
          port: { run: async argv => { queued.push([...argv]); return { status: 'queued' }; } } } });
      for (const binding of [bob, carol]) composed.control.observe(binding, { version: '0.154.0', hookReview: 'trusted' });
      const activity = createCodexIdleActivity(w.root);
      await activity.mark(carol, true, 'carol-thread');
      const root = w.send('human');
      w.acknowledge(bob, root);
      const peer = w.send('bob', bob);
      expect(composed.control.peerWake?.(carol, peer)).toBe(true);
      const read = composed.releases.read({ binding: carol, channelId: room, cursor: null, limit: 10 });
      expect(read.kind).toBe('page');
      if (read.kind !== 'page') throw new Error('no page');
      expect(read.releases.find(release => release.events[0]?.eventId === peer.eventId)?.wake).toBe(true);
      await composed.control.idleWake?.(carol, 'carol-thread', () => true);
      expect(queued).toHaveLength(1);
      expect(JSON.stringify(queued)).not.toContain('message 2');
      // A forged/stale end with the idle epoch present at claim cannot finish it.
      expect(await composed.control.turnEnd?.(carol, 'bob-thread', room, null, () => true)).toBe(false);
      w.acknowledge(carol, peer);
      const pending = w.send('bob', bob);
      expect(composed.control.peerWake?.(carol, pending)).toBe(false);
      const busyPage = composed.releases.read({ binding: carol, channelId: room, cursor: null, limit: 10 });
      expect(busyPage.kind).toBe('page');
      if (busyPage.kind !== 'page') throw new Error('no busy page');
      expect(busyPage.releases.map(release => release.events[0]?.eventId)).toEqual([root.eventId, peer.eventId]);
      expect(composed.releases.read({ binding: carol, channelId: room, cursor: busyPage.nextCursor, limit: 10 }))
        .toEqual({ kind: 'held', reason: 'peer_busy' });
      await activity.mark(carol, false, 'carol-thread');
      await activity.mark(carol, true, 'carol-thread');
      expect(await composed.control.turnEnd?.(carol, 'carol-thread', room, null, () => true)).toBe(true);
      expect(queued).toHaveLength(2);
      expect(composed.control.peerPending?.(carol, room)).toBe(true);
      const resumed = composed.releases.read({ binding: carol, channelId: room, cursor: busyPage.nextCursor, limit: 10 });
      expect(resumed.kind).toBe('page');
      if (resumed.kind !== 'page') throw new Error('no resumed page');
      expect(resumed.releases.map(release => [release.events[0]?.eventId, release.wake])).toEqual([[pending.eventId, true]]);
      expect(await composed.control.turnEnd?.(carol, 'carol-thread', room, null, () => true)).toBe(true);
      expect(w.ledger.reserve({ recipient: carol, event: pending, mode: w.mode(carol) })).toMatchObject({
        kind: 'duplicate', state: 'reserved',
      });
    } finally { w.handle.close(); }
  });

  it('routes an authenticated agent send through the production server to one content-free peer wake', async () => {
    const w = world();
    const queued: string[][] = [];
    const composed = composeBindingModes({ handle: w.handle, store: w.store, stateDirectory: w.root,
      codexWake: { inspect: async () => ({ version: '0.154.0', hookReview: 'trusted' }),
        port: { run: async argv => { queued.push([...argv]); return { status: 'queued' }; } } } });
    for (const binding of [bob, carol]) composed.control.observe(binding, { version: '0.154.0', hookReview: 'trusted' });
    await createCodexIdleActivity(w.root).mark(carol, true, 'carol-thread');
    const stop = composeBindingControl({ handle: w.handle, root: w.root });
    const bobCredential = mintCredential();
    const carolCredential = mintCredential();
    const server = await startChannelServer({ store: w.store, bootstrap: [],
      bindings: [{ credential: bobCredential, binding: bob, channels: [room] },
        { credential: carolCredential, binding: carol, channels: [room] }],
      releases: composed.releases, bindingModes: composed.control, stop,
      newId: () => 'event-server-peer', clock: () => Date.parse('2026-09-27T00:00:03.000Z'), startPort: 0 });
    try {
      const root = w.send('human');
      w.acknowledge(bob, root);
      const invalid = await fetch(`${server.origin}/api/v1/channels/${room}/messages`, {
        method: 'POST', headers: { authorization: `Bearer ${bobCredential}`, 'content-type': 'application/json' },
        body: JSON.stringify({ clientTxnId: 'forged', content: { v: 1, kind: 'text', body: 'forged' },
          authorParticipantId: carol.agentParticipantId }),
      });
      expect(invalid.status).toBe(400);
      const sent = await fetch(`${server.origin}/api/v1/channels/${room}/messages`, {
        method: 'POST', headers: { authorization: `Bearer ${bobCredential}`, 'content-type': 'application/json' },
        body: JSON.stringify({ clientTxnId: 'peer-server', content: { v: 1, kind: 'text', body: 'private peer words' } }),
      });
      expect(sent.status).toBe(201);
      await waitFor(() => queued.length === 1);
      expect(JSON.stringify(queued)).not.toContain('private peer words');
      const feed = await fetch(`${server.origin}/api/v1/channels/${room}/releases?limit=10`, {
        headers: { authorization: `Bearer ${carolCredential}` },
      });
      expect(feed.status).toBe(200);
      const page = await feed.json() as { releases: Array<{ events: Array<{ eventId: string }>; wake: boolean }> };
      expect(page.releases.find(release => release.events[0]?.eventId === 'event-server-peer')?.wake).toBe(true);
      const principal = { bindingId: carol.bindingId, generation: carol.generation };
      const acknowledgements = createAgentAcknowledgementLedger(w.handle);
      const offered = { releaseId: internalReleaseId(carol, 'event-server-peer'), eventIds: ['event-server-peer'] };
      const proof = acknowledgements.issueRelease({ principal, channelId: room, release: offered });
      expect(acknowledgements.issueBatch({ principal, channelId: room, releases: [{ ...offered, proof }] })).not.toBeNull();
      const end = (sessionId: string, channelId: string = room) => fetch(`${server.origin}/api/v1/agent/automation-turn-end`, {
        method: 'POST', headers: { authorization: `Bearer ${carolCredential}`, 'content-type': 'application/json' },
        body: JSON.stringify({ v: 1, sessionId, channelId }),
      });
      expect((await end('bob-thread')).status).toBe(403);
      expect((await end('carol-thread')).status).toBe(200);
      expect(w.handle.read(db => db.prepare('SELECT state FROM automation_releases WHERE event_id = ?')
        .get('event-server-peer'))).toEqual({ state: 'reserved' });
      await createCodexIdleActivity(w.root).mark(carol, false, 'carol-thread');
      await createCodexIdleActivity(w.root).mark(carol, true, 'carol-thread');
      expect((await end('carol-thread', 'wrong-room')).status).toBe(403);
      expect(w.handle.read(db => db.prepare('SELECT state FROM automation_releases WHERE event_id = ?')
        .get('event-server-peer'))).toEqual({ state: 'reserved' });
      expect((await end('carol-thread')).status).toBe(200);
      expect(w.handle.read(db => db.prepare('SELECT state FROM automation_releases WHERE event_id = ?')
        .get('event-server-peer'))).toEqual({ state: 'finished' });
    } finally { await server.close(); stop.close(); w.handle.close(); }
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('expected asynchronous wake');
}
