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
import { describeLeaks } from './fixtures';
import {
  approval, binding, bindingId, closeHostedWorlds, codexSession, openStore, sessionCapture,
  startConnector,
  seedCanaryPair,
} from './hosted-world';

afterEach(closeHostedWorlds);

const seeded = seedCanaryPair;

describe('restore and damaged state', () => {
  /** A release written to the session with its reply lost, then restarted from a closed copy of that ledger. */
  async function restoredAfterLostReply() {
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

  it('a ledger copied after a lost reply and restored never resubmits the release', async () => {
    const { s, session, record } = await restoredAfterLostReply();
    expect(session.server.adds()).toBe(1);
    expect(record?.state).toBe('outcome_unknown');
    const leaks = sessionCapture(session).leaks([s.pending]);
    expect(leaks, describeLeaks(leaks)).toEqual([]);
  });

  // #380: the KHA-121 dispatcher keeps its dispatch evidence in `dispatch_records`, not the
  // `receipts` table. The KHA-136 recovery view must still read a release already written to the
  // session as an unknown outcome, so the lifecycle holds and reconciles it.
  it('the recovery view reports that release as an unknown outcome, not undispatched', async () => {
    const { lifecycle } = await restoredAfterLostReply();
    expect(lifecycle.observe()).toMatchObject({ state: 'ready', unknownReleaseIds: ['release_1'], undispatchedReleases: 0 });
  });

  it('a stale backup from before dispatch, restored after delivery, is recorded as observed', async () => {
    const s = await seeded();
    const session = codexSession(s.workdir);
    const crashed = await startConnector(s.state.storage, session, { dropHandoff: true });
    expect(await crashed.approve(approval([s.approvedRef]))).toMatchObject({ ok: true });
    await crashed.stop();
    await s.state.storage.close();
    // Backup taken while the approved release was committed but not yet dispatched.
    const backup = path.join(s.workdir, 'backup');
    fs.cpSync(s.state.state, backup, { recursive: true });
    fs.chmodSync(backup, 0o700);
    for (const file of fs.readdirSync(backup)) fs.chmodSync(path.join(backup, file), 0o600);

    // The original ledger dispatches, and the session takes the entry.
    const original = await startConnector(await openStore(s.state.state, 'existing'), codexSession(s.workdir, { server: session.server, notified: session.notified }));
    await original.dispatcher.idle();
    await original.stop();
    expect(session.server.adds()).toBe(1);
    session.server.consumeNext();

    // Disaster: the owner restores the older backup.
    const restored = await openStore(backup, 'existing');
    const after = await startConnector(restored, codexSession(s.workdir, { server: session.server, notified: session.notified }));
    await after.dispatcher.idle();

    // The stale backup holds no evidence the release was sent, so the approved content is
    // offered to the session a second time. It was approved content, so this is a
    // delivery-count limit of restoring a stale backup, not a confidentiality breach.
    expect(session.server.adds()).toBe(2);
    const leaks = sessionCapture(session).leaks([s.pending]);
    expect(leaks, describeLeaks(leaks)).toEqual([]);
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
