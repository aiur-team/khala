// Crash windows with real processes: a child opens the on-disk store, stops at an
// exact boundary and is SIGKILLed. The parent then reopens the same directory and
// inspects what was durably committed. No graceful close ever runs in the child.

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { bindingId, eventRef, limits, pendingInput, scratchDirectory } from './fakes';
import { type ConnectorStorage, openConnectorStorage } from './open';
import { recoverConnectorStorage } from './recovery';

const storageDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(storageDir, '../..');

type Child = { process: ChildProcessWithoutNullStreams; line: Promise<unknown>; exited: Promise<unknown> };

/**
 * Runs `body` in a separate Node process with `open`, `fx` (fixtures), `limits` and
 * `dir` in scope. The child prints its JSON result, then keeps its store open (and its
 * lock held) until it is killed.
 */
function spawnChild(dir: string, body: string): Child {
  const script = `
    import { openConnectorStorage as open } from ${JSON.stringify(path.join(storageDir, 'open.ts'))};
    import * as fx from ${JSON.stringify(path.join(storageDir, 'fakes.ts'))};
    const limits = fx.limits;
    const dir = ${JSON.stringify(dir)};
    let out;
    try {
      out = { ok: true, result: await (async () => { ${body} })() };
    } catch (error) {
      out = { ok: false, code: error?.code ?? String(error) };
    }
    process.stdout.write(JSON.stringify(out) + '\\n');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--no-warnings', '--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: packageRoot,
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const line = new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', chunk => {
      out += String(chunk);
      const end = out.indexOf('\n');
      if (end >= 0) resolve(JSON.parse(out.slice(0, end)));
    });
    void exited.then(() => reject(new Error(`child exited early: ${stderr}`)));
  });
  return { process: child, line, exited };
}

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
    expect(snap?.pending).toHaveLength(1);
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
      const command = fx.approval('command_1', [fx.eventRef('event_7', 'hello')]);
      const payload = fx.content('envelope');
      const job = fx.release(command, fx.binding(0), payload);
      return await s.ledger.transaction(tx => {
        const put = tx.putRelease({ command: fx.commandRecord(command, job.releaseId), job, payload,
          expectedLedgerRevision: tx.ledgerRevision() });
        tx.appendReceipt({ receipt: fx.receipt(job.releaseId, 'dispatching') });
        return put;
      });
    `);
    expect(result).toEqual({ ok: true, result: { kind: 'committed' } });
    await killHard(child);

    const storage = await reopen(dir);
    const report = await recoverConnectorStorage(storage);
    expect(report.unresolvedReleases).toEqual(['release_r7']);
    expect(report.blocked).toEqual([]);
  }, TIMEOUT);
});
