// U3: recovery. A ledger restored from a backup never replays a release that was
// already written to the session, and damaged stored bytes block dispatch rather
// than falling back to anything else. Messaging key loss and restore are not wired
// (no relay adapter), so they are recorded as not-observed evidence, not tested here.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createConnectorDispatchStorage } from '@khala/connector/storage/dispatch';
import { bindRecoveryLifecycle, storageRecoveryDeps } from '../../../apps/connector/src/composition/recovery/lifecycle';
import { describeLeaks, mintCanary } from './fixtures';
import {
  approval, binding, bindingId, closeHostedWorlds, codexSession, eventRef, openStore, seedLedger, sessionCapture,
  startConnector,
} from './hosted-world';

afterEach(closeHostedWorlds);

async function seeded() {
  const approved = mintCanary('approved');
  const pending = mintCanary('pending');
  const approvedRef = eventRef('event_approved', approved.text);
  const pendingRef = eventRef('event_pending', pending.text);
  const state = await seedLedger([{ ref: approvedRef, body: approved.text }, { ref: pendingRef, body: pending.text }]);
  return { approved, pending, approvedRef, pendingRef, state, workdir: path.dirname(state.state) };
}

describe('restore and damaged state', () => {
  /** A release written to the session with its reply lost, then the ledger restored from a closed backup. */
  async function restoredMidDispatch() {
    const s = await seeded();
    const session = codexSession(s.workdir);
    // The reply to the write is lost, so the release is dispatched with an unknown outcome.
    session.server.override('thread/queue/add', () => ({ status: 'lost', written: true, cause: 'disconnected' }));
    const first = await startConnector(s.state.storage, session);
    expect(await first.approve(approval([s.approvedRef]))).toMatchObject({ ok: true });
    await first.dispatcher.idle();
    await first.stop();
    await s.state.storage.close();
    const backup = path.join(s.workdir, 'backup');
    fs.cpSync(s.state.state, backup, { recursive: true });
    // A restore keeps the owner-only modes the ledger requires.
    fs.chmodSync(backup, 0o700);
    for (const file of fs.readdirSync(backup)) fs.chmodSync(path.join(backup, file), 0o600);

    const restored = await openStore(backup, 'existing');
    const second = await startConnector(restored, codexSession(s.workdir, { server: session.server, notified: session.notified }));
    const lifecycle = bindRecoveryLifecycle({ ...storageRecoveryDeps({ storage: restored, dispatcher: second.dispatcher, bindingId }), binding });
    await lifecycle.start();
    await second.dispatcher.idle();
    const record = await createConnectorDispatchStorage(restored).ledger.transact(tx => tx.record('release_1' as never));
    return { s, session, lifecycle, record };
  }

  it('a ledger restored from a backup taken mid-dispatch never resubmits the release', async () => {
    const { s, session, record } = await restoredMidDispatch();
    expect(session.server.adds()).toBe(1);
    expect(record?.state).toBe('outcome_unknown');
    const leaks = sessionCapture(session).leaks([s.pending]);
    expect(leaks, describeLeaks(leaks)).toEqual([]);
  });

  // KNOWN DEFECT (KHA-136 composition), #380: `recoverConnectorStorage`
  // reads dispatch evidence only from the `receipts` table, but the KHA-121 dispatcher keeps its
  // receipts inside `dispatch_records`. In the composed connector the recovery view therefore
  // reports a release already written to the session as undispatched and never reconciles it.
  // The dispatcher's own ledger still prevents a resubmission (above); the owner-facing
  // recovery status is wrong. `it.fails` keeps this visible and flips when it is fixed.
  it.fails('KNOWN DEFECT: the recovery view reports that release as an unknown outcome, not undispatched', async () => {
    const { lifecycle } = await restoredMidDispatch();
    expect(lifecycle.observe()).toMatchObject({ state: 'ready', unknownReleaseIds: ['release_1'], undispatchedReleases: 0 });
  });

  it('damaged release bytes block dispatch; nothing else is sent in their place', async () => {
    const s = await seeded();
    const session = codexSession(s.workdir);
    const crashed = await startConnector(s.state.storage, session, { dropHandoff: true });
    expect(await crashed.approve(approval([s.approvedRef]))).toMatchObject({ ok: true });
    await crashed.stop();
    const committed = await s.state.storage.ledger.transaction(tx => tx.readRelease('release_1' as never));
    const payloadRef = committed!.job.payloadRef;
    await s.state.storage.close();

    // Corrupt the committed release payload on disk, as a bad restore or disk fault would.
    const db = new DatabaseSync(path.join(s.state.state, 'ledger.sqlite'));
    db.prepare('UPDATE payloads SET bytes = ? WHERE payload_ref = ?').run(Buffer.from('damaged'), payloadRef);
    db.close();

    const storage = await openStore(s.state.state, 'existing');
    const restarted = await startConnector(storage, codexSession(s.workdir, { server: session.server, notified: session.notified }));
    const lifecycle = bindRecoveryLifecycle({ ...storageRecoveryDeps({ storage, dispatcher: restarted.dispatcher, bindingId }), binding });
    await lifecycle.start();
    await restarted.dispatcher.idle();

    expect(lifecycle.observe()).toMatchObject({ state: 'blocked', reasons: expect.arrayContaining(['payload_damaged']) });
    expect(session.server.adds()).toBe(0);
    const leaks = sessionCapture(session).leaks([s.pending, s.approved]);
    expect(leaks, describeLeaks(leaks)).toEqual([]);
  });
});
