// Crash windows with real processes: a child opens the on-disk store, stops at an
// exact boundary and is SIGKILLed. The parent then reopens the same directory and
// inspects what was durably committed. No graceful close ever runs in the child. One
// window kills the child inside an open transaction; the others kill it after commit.

import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { type Child, spawnChild } from './fixtures/child';
import { bindingId, eventRef, limits, pendingInput, scratchDirectory } from './fixtures/fakes';
import { type ConnectorStorage, openConnectorStorage } from './open';
import { recoverConnectorStorage } from './recovery';

const children: Child[] = [];
const opened: ConnectorStorage[] = [];
const scratch: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.process.kill('SIGKILL');
    await child.exited;
  }
  await Promise.all(opened.splice(0).map(storage => storage.close()));
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function runChild(dir: string, body: string) {
  const child = spawnChild(dir, body);
  children.push(child);
  return { child, result: await child.line };
}

async function killHard(child: Child) {
  child.process.kill('SIGKILL');
  await child.exited;
}

async function reopen(directory: string) {
  const storage = await openConnectorStorage({ directory, mode: 'existing', limits });
  opened.push(storage);
  return storage;
}

function state() {
  const d = scratchDirectory();
  scratch.push(d.parent);
  return d.state;
}

const TIMEOUT = 30_000;

describe('crash recovery across processes', () => {
  it('refuses a second process while the owner lives and recovers the lock when it dies', async () => {
    const dir = state();
    const { child, result } = await runChild(dir, `
      const s = await open({ directory: dir, mode: 'create', limits });
      return s.epoch;
    `);
    expect(result).toEqual({ ok: true, result: 1 });

    await expect(openConnectorStorage({ directory: dir, mode: 'existing', limits })).rejects.toMatchObject({ code: 'locked' });
    const second = await runChild(dir, `await open({ directory: dir, mode: 'existing', limits });`);
    expect(second.result).toEqual({ ok: false, code: 'locked' });

    // SIGKILL leaves no graceful unlock; the kernel releases the OS lock, no PID text involved.
    await killHard(child);
    const storage = await reopen(dir);
    expect(storage.epoch).toBe(2);
  }, TIMEOUT);

  it('replays harmlessly after a crash between pending persistence and cursor advance (AE1)', async () => {
    const dir = state();
    const { child, result } = await runChild(dir, `
      const s = await open({ directory: dir, mode: 'create', limits });
      await s.ledger.transaction(tx => tx.putBinding(fx.binding(0)));
      return await s.persistPending(fx.pendingInput('event_7', 'hello'));
    `);
    expect(result).toEqual({ ok: true, result: { kind: 'inserted' } });
    await killHard(child);

    const storage = await reopen(dir);
    expect(await storage.readCursor('sync')).toBeNull();
    // The SDK replays the same event; it deduplicates by immutable identity.
    expect(await storage.persistPending(pendingInput('event_7', 'hello'))).toEqual({ kind: 'duplicate' });
    expect(await storage.commitCursor({ streamId: 'sync', expectedRevision: 0, opaqueCursor: 'after_7' }))
      .toEqual({ kind: 'committed', revision: 1 });

    const snap = await storage.ledger.transaction(tx => tx.readApprovalSnapshot({
      bindingId, selection: [eventRef('event_7', 'hello')],
    }));
    expect(snap).toMatchObject({ kind: 'snapshot', pending: [{ key: { eventId: 'event_7' } }] });
    const report = await recoverConnectorStorage(storage);
    expect(report).toMatchObject({ pending: 1, quarantined: 0, blocked: [], epoch: 2 });
  }, TIMEOUT);

  it('reloads the durable cursor when the committer dies before reporting', async () => {
    const dir = state();
    const { child } = await runChild(dir, `
      const s = await open({ directory: dir, mode: 'create', limits });
      return await s.commitCursor({ streamId: 'sync', expectedRevision: 0, opaqueCursor: 'c1' });
    `);
    await killHard(child);

    const storage = await reopen(dir);
    expect(await storage.readCursor('sync')).toEqual({ revision: 1, opaqueCursor: 'c1' });
    expect(await storage.commitCursor({ streamId: 'sync', expectedRevision: 0, opaqueCursor: 'c1' }))
      .toMatchObject({ kind: 'conflict', code: 'stale_revision', revision: 1 });
  }, TIMEOUT);

  it('reports a release with unknown harness outcome instead of authorising a resubmit', async () => {
    const dir = state();
    const { child, result } = await runChild(dir, `
      const s = await open({ directory: dir, mode: 'create', limits });
      await s.ledger.transaction(tx => tx.putBinding(fx.binding(0)));
      await s.persistPending(fx.pendingInput('event_7', 'hello'));
      await s.persistPending(fx.pendingInput('event_8', 'later'));
      const releaseOf = (eventId, body, commandId, releaseId, kind) => s.ledger.transaction(tx => {
        const command = fx.approval(commandId, [fx.eventRef(eventId, body)]);
        const payload = fx.content(body + ' envelope');
        const job = fx.release(command, fx.binding(0), payload, releaseId);
        const put = tx.putRelease({ command: fx.commandRecord(command, job.releaseId), job, payload,
          expectedLedgerRevision: tx.ledgerRevision() });
        if (kind) tx.appendReceipt({ receipt: fx.receipt(job.releaseId, kind) });
        return put;
      });
      return [
        await releaseOf('event_7', 'hello', 'command_1', 'release_r7', 'dispatching'),
        await releaseOf('event_8', 'later', 'command_2', 'release_r8', 'queued'),
      ];
    `);
    expect(result).toEqual({ ok: true, result: [{ kind: 'committed' }, { kind: 'committed' }] });
    await killHard(child);

    const storage = await reopen(dir);
    const report = await recoverConnectorStorage(storage);
    expect(report.outcomeUnknownReleases).toEqual(['release_r7']);
    expect(report.undispatchedReleases).toEqual(['release_r8']);
    expect(report.blocked).toEqual([]);
  }, TIMEOUT);

  it('commits nothing when the owner dies inside an open transaction', async () => {
    const dir = state();
    const { child, result } = await runChild(dir, `
      const s = await open({ directory: dir, mode: 'create', limits });
      await s.ledger.transaction(tx => tx.putBinding(fx.binding(0)));
      await s.persistPending(fx.pendingInput('event_7', 'hello'));
      await s.ledger.transaction(tx => {
        const command = fx.approval('command_1', [fx.eventRef('event_7', 'hello')]);
        const payload = fx.content('envelope');
        const job = fx.release(command, fx.binding(0), payload);
        tx.putRelease({ command: fx.commandRecord(command, job.releaseId), job, payload,
          expectedLedgerRevision: tx.ledgerRevision() });
        tx.appendReceipt({ receipt: fx.receipt(job.releaseId, 'dispatching') });
        tx.putBinding(fx.binding(1));
        // Every write above is inside the open transaction. Report, then hang in it.
        signal(tx.ledgerRevision());
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      });
    `);
    expect(result).toEqual({ ok: true, signal: 5 });
    await killHard(child);

    const storage = await reopen(dir);
    const report = await recoverConnectorStorage(storage);
    expect(report).toMatchObject({
      ledgerRevision: 2, pending: 1, outcomeUnknownReleases: [], undispatchedReleases: [], blocked: [],
    });
    expect(await storage.ledger.transaction(tx => [tx.readRelease('release_r7' as never), tx.readBinding(bindingId)?.generation]))
      .toEqual([null, 0]);
  }, TIMEOUT);
});
