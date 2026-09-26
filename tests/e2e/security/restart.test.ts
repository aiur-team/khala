// U3: process restarts at the journal, dispatcher and harness boundaries. Each case
// stops the connector process at a boundary, reopens the same on-disk ledger in a
// new process with a new adapter instance, and checks that nothing is blindly
// retried, nothing reaches a replacement session, and the pending neighbour never
// leaks. The fake app-server survives the restart, as the user's Codex session would.

import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReleaseId, SessionBinding } from '@khala/contracts/delivery/index';
import { createConnectorDispatchStorage } from '@khala/connector/storage/dispatch';
import { describeLeaks, mintCanary } from './fixtures';
import {
  type CodexSession, approval, binding, closeHostedWorlds, codexSession, eventRef, openStore, seedLedger,
  sessionCapture, startConnector,
} from './hosted-world';

afterEach(closeHostedWorlds);

async function seeded() {
  const pending = mintCanary('pending');
  const approved = mintCanary('approved');
  const pendingRef = eventRef('event_pending', `withheld ${pending.text}`);
  const approvedRef = eventRef('event_approved', `chosen ${approved.text}`);
  const state = await seedLedger([
    { ref: pendingRef, body: `withheld ${pending.text}` },
    { ref: approvedRef, body: `chosen ${approved.text}` },
  ]);
  return { pending, approved, pendingRef, approvedRef, state };
}

/** A new adapter instance over the same surviving session, as after a connector restart. */
function reattach(session: CodexSession, workdir: string): CodexSession {
  return codexSession(workdir, { server: session.server, notified: session.notified });
}

async function recordState(storage: Parameters<typeof createConnectorDispatchStorage>[0], releaseId: string) {
  return createConnectorDispatchStorage(storage).ledger.transact(tx => tx.record(releaseId as ReleaseId));
}

describe('restart and lifecycle faults fail closed', () => {
  it('a crash between approval commit and dispatcher handoff resumes the same release once after restart', async () => {
    const s = await seeded();
    const workdir = path.dirname(s.state.state);
    const session = codexSession(workdir);
    const crashed = await startConnector(s.state.storage, session, { dropHandoff: true });
    expect(await crashed.approve(approval([s.approvedRef]))).toEqual({ ok: true, releaseIds: ['release_1'] });
    expect(session.server.adds()).toBe(0);
    await crashed.stop();
    await s.state.storage.close();

    const restarted = await startConnector(await openStore(s.state.state, 'existing'), reattach(session, workdir));
    await restarted.dispatcher.idle();
    expect(session.server.adds()).toBe(1);
    const capture = sessionCapture(session);
    expect(capture.carrying(s.approved)).toEqual(['model:codex-app-server']);
    expect(capture.leaks([s.pending])).toEqual([]);
  });

  it('a crash after the harness accepted the write is never blindly retried', async () => {
    const s = await seeded();
    const workdir = path.dirname(s.state.state);
    const session = codexSession(workdir);
    // The entry reaches the session's native queue; the reply is lost with the connection.
    session.server.override('thread/queue/add', params => {
      const [first] = params.input as { text: string }[];
      session.server.queue.push({ id: 'q-lost', clientUserMessageId: String(params.clientUserMessageId), text: first!.text });
      return { status: 'lost', written: true, cause: 'disconnected' };
    });
    const first = await startConnector(s.state.storage, session);
    expect(await first.approve(approval([s.approvedRef]))).toMatchObject({ ok: true });
    await first.dispatcher.idle();
    const before = await recordState(s.state.storage, 'release_1');
    await first.stop();
    await s.state.storage.close();

    const reopened = await openStore(s.state.state, 'existing');
    const second = await startConnector(reopened, reattach(session, workdir));
    await second.dispatcher.idle();
    // The owner retrying the same command answers from the journal; it is not a new release.
    expect(await second.approve(approval([s.approvedRef]))).toEqual({ ok: true, releaseIds: ['release_1'] });
    await second.dispatcher.idle();

    expect(session.server.adds()).toBe(1);
    expect(session.server.queue.map(entry => entry.clientUserMessageId)).toEqual(['release_1']);
    // The lost reply is explicit ambiguity. After restart, reconciliation finds the entry in
    // the session's native queue by release ID, so the accepted release is observed once.
    const after = await recordState(reopened, 'release_1');
    expect({ before: before?.state, after: after?.state }).toEqual({ before: 'outcome_unknown', after: 'accepted' });
    const leaks = sessionCapture(session).leaks([s.pending]);
    expect(leaks, describeLeaks(leaks)).toEqual([]);
  });

  it('when the session already took the entry, the outcome stays explicitly unknown and is not resubmitted', async () => {
    const s = await seeded();
    const workdir = path.dirname(s.state.state);
    const session = codexSession(workdir);
    session.server.override('thread/queue/add', params => {
      const [first] = params.input as { text: string }[];
      session.server.queue.push({ id: 'q-lost', clientUserMessageId: String(params.clientUserMessageId), text: first!.text });
      return { status: 'lost', written: true, cause: 'disconnected' };
    });
    const first = await startConnector(s.state.storage, session);
    expect(await first.approve(approval([s.approvedRef]))).toMatchObject({ ok: true });
    await first.dispatcher.idle();
    await first.stop();
    await s.state.storage.close();
    // The session started a turn from the entry while the connector was down.
    session.server.consumeNext();

    const reopened = await openStore(s.state.state, 'existing');
    const second = await startConnector(reopened, reattach(session, workdir));
    await second.dispatcher.idle();

    expect(session.server.adds()).toBe(1);
    expect((await recordState(reopened, 'release_1'))?.state).toBe('outcome_unknown');
    expect(sessionCapture(session).leaks([s.pending])).toEqual([]);
  });

  it('a rebind after approval and before dispatch never delivers the old generation\'s release to the new session', async () => {
    const s = await seeded();
    const workdir = path.dirname(s.state.state);
    const session = codexSession(workdir);
    const crashed = await startConnector(s.state.storage, session, { dropHandoff: true });
    expect(await crashed.approve(approval([s.approvedRef]))).toMatchObject({ ok: true });
    await crashed.stop();
    // The owner rebinds the agent to a replacement session before the release dispatched.
    const replacement: SessionBinding = { ...binding, generation: 1, sessionId: 'replacement-session-b' };
    await s.state.storage.ledger.transaction(tx => tx.putBinding(replacement));
    await s.state.storage.close();

    const replacementSession = codexSession(workdir, { bindingOverride: replacement });
    const restarted = await startConnector(await openStore(s.state.state, 'existing'), replacementSession);
    await restarted.dispatcher.idle();

    expect(replacementSession.server.adds()).toBe(0);
    expect(session.server.adds()).toBe(0);
    const capture = sessionCapture(replacementSession);
    expect(capture.leaks([s.pending, s.approved])).toEqual([]);
    // An approval against the stale generation is refused as well. The replacement generation has
    // no effective policy yet (the listening projection owns seeding it), so the answer is `unavailable`.
    expect(await restarted.approve(approval([s.pendingRef], { commandId: 'approve-9' as never }))).toEqual({ ok: false, code: 'unavailable' });
  });

  it('a pause committed after approval holds delivery across a restart; resume delivers once without a new approval', async () => {
    const s = await seeded();
    const workdir = path.dirname(s.state.state);
    const session = codexSession(workdir);
    const crashed = await startConnector(s.state.storage, session, { dropHandoff: true });
    expect(await crashed.approve(approval([s.approvedRef]))).toMatchObject({ ok: true });
    await crashed.stop();
    const policy = (paused: boolean, version: number) => ({
      version, armedAt: 3, paused, expiresAt: null,
      listening: { version: 1, requested: 'sync' as const, effective: 'sync' as const, evidenceRevision: 'evidence-kha138' },
    });
    await createConnectorDispatchStorage(s.state.storage).applyEffectivePolicy({ binding, policy: policy(true, 4) });
    await s.state.storage.close();

    let storage = await openStore(s.state.state, 'existing');
    const paused = await startConnector(storage, reattach(session, workdir));
    await paused.dispatcher.idle();
    expect(session.server.adds()).toBe(0);
    expect((await recordState(storage, 'release_1'))?.state).toBe('queued');
    await paused.stop();

    await createConnectorDispatchStorage(storage).applyEffectivePolicy({ binding, policy: policy(false, 5) });
    await storage.close();
    storage = await openStore(s.state.state, 'existing');
    const resumed = await startConnector(storage, reattach(session, workdir));
    await resumed.dispatcher.idle();
    expect(session.server.adds()).toBe(1);
    expect(sessionCapture(session).leaks([s.pending])).toEqual([]);
  });
});
