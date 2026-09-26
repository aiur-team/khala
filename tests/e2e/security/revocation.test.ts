// U3: revocation. A revoked or superseded agent binding reads nothing sent after
// revocation on any agent surface, and a revoked hosted binding can neither be
// approved for nor dispatched to, even for a release approved before revocation.

import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createConnectorDispatchStorage } from '@khala/connector/storage/dispatch';
import { bindRecoveryLifecycle, storageRecoveryDeps } from '../../../apps/connector/src/composition/recovery/lifecycle';
import { createSurfaceCapture, describeLeaks, mintCanary, scanTree } from './fixtures';
import {
  approval, binding, bindingId, closeHostedWorlds, codexSession, eventRef, openStore, seedLedger, sessionCapture,
  startConnector,
} from './hosted-world';
import { type InternalWorld, bobBinding, channelId, startInternalWorld } from './internal-world';

const worlds: InternalWorld[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.close();
  await closeHostedWorlds();
});

const held = { bindingId: bobBinding.bindingId, generation: bobBinding.generation };

/** Every agent read path for a binding whose authority just ended. */
async function agentView(w: InternalWorld) {
  const capture = createSurfaceCapture();
  for (const route of [
    `/api/v1/channels/${channelId}/timeline`, `/api/v1/channels/${channelId}/releases?limit=50`,
    `/api/v1/channels/${channelId}`, '/api/v1/agent/binding',
  ]) {
    const response = await w.http('GET', route);
    expect(response.status, route).toBe(401);
    capture.add(`GET ${route}`, response.body);
  }
  const read = await w.khala(['read'], { descriptor: true });
  capture.add('cli:read', read.out + read.err);
  const mcp = await w.khala(['mcp-serve'], {
    descriptor: true,
    stdin: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'khala_read', arguments: {} } })}\n`,
  });
  capture.add('mcp-tool:khala_read', mcp.out + mcp.err);
  return capture;
}

describe('revoked and superseded bindings', () => {
  it('internal: after revocation the agent reads nothing new on any surface; earlier delivery stands', async () => {
    const w = await startInternalWorld();
    worlds.push(w);
    const before = mintCanary('before');
    const after = mintCanary('after');
    w.say(channelId, before.text);
    expect((await w.khala(['read'], { descriptor: true })).out).toContain(before.core);

    expect(w.fixture.store.revokeBinding(held).kind).toBe('done');
    w.say(channelId, after.text);

    const capture = await agentView(w);
    const leaks = [...capture.leaks([after]), ...scanTree(w.agentState, [after])];
    expect(leaks, describeLeaks(leaks)).toEqual([]);
  });

  it('internal: a superseded generation reads nothing new once a newer binding exists', async () => {
    const w = await startInternalWorld();
    worlds.push(w);
    const after = mintCanary('after');
    expect(w.fixture.store.registerBinding({ ...bobBinding, generation: bobBinding.generation + 1 }).kind).toBe('done');
    w.say(channelId, after.text);

    const capture = await agentView(w);
    const leaks = [...capture.leaks([after]), ...scanTree(w.agentState, [after])];
    expect(leaks, describeLeaks(leaks)).toEqual([]);
  });

  it('hosted: a revoked binding cannot be approved for, previewed or dispatched to, even for an earlier approval', async () => {
    const approved = mintCanary('approved');
    const pending = mintCanary('pending');
    const approvedRef = eventRef('event_approved', approved.text);
    const pendingRef = eventRef('event_pending', pending.text);
    const state = await seedLedger([{ ref: approvedRef, body: approved.text }, { ref: pendingRef, body: pending.text }]);
    const workdir = path.dirname(state.state);
    const session = codexSession(workdir);
    // Approved and committed, but the process died before the dispatcher took it.
    const crashed = await startConnector(state.storage, session, { dropHandoff: true });
    expect(await crashed.approve(approval([approvedRef]))).toMatchObject({ ok: true });
    await crashed.stop();
    await state.storage.ledger.transaction(tx => tx.putRevocation({
      targetKind: 'binding', targetId: bindingId, generation: binding.generation, operationId: 'op_revoke_1',
      revokedAt: '2026-09-25T10:02:00Z',
    }));
    await state.storage.close();

    const storage = await openStore(state.state, 'existing');
    const restarted = await startConnector(storage, codexSession(workdir, { server: session.server, notified: session.notified }));
    await restarted.dispatcher.idle();
    expect(await restarted.approve(approval([pendingRef], { commandId: 'approve-after' as never }))).toEqual({ ok: false, code: 'forbidden' });
    expect(await restarted.preview({ bindingId, candidates: [pendingRef], releaseIds: [] })).toEqual({ ok: false, code: 'revoked' });

    const lifecycle = bindRecoveryLifecycle({
      ...storageRecoveryDeps({ storage, dispatcher: restarted.dispatcher, bindingId }), binding,
    });
    await lifecycle.start();
    expect(lifecycle.observe()).toMatchObject({ state: 'blocked', reasons: ['binding_revoked'] });

    expect(session.server.adds()).toBe(0);
    const leaks = sessionCapture(session).leaks([approved, pending]);
    expect(leaks, describeLeaks(leaks)).toEqual([]);
    const record = await createConnectorDispatchStorage(storage).ledger.transact(tx => tx.record('release_1' as never));
    expect(record?.state).not.toMatch(/accepted|completed|dispatching/);
  });
});
