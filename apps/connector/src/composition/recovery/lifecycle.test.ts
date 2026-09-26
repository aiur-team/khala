import fs from 'node:fs';
import path from 'node:path';
import type { ReleaseId } from '@khala/contracts/delivery/index';
import type { RetentionReport } from '@khala/connector/retention/index';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fx from '../../../../../packages/connector/src/storage/fixtures/fakes';
import { type ConnectorStorage, openConnectorStorage } from '../../../../../packages/connector/src/storage/open';
import type { ConnectorCapabilityContext } from '../../runtime/capabilities';
import { bindRecoveryLifecycle, storageRecoveryDeps } from './lifecycle';
import { registerRecovery } from './register';

const opened: ConnectorStorage[] = [];
const scratch: string[] = [];
const getuid = Object.getOwnPropertyDescriptor(process, 'getuid');
const getgid = Object.getOwnPropertyDescriptor(process, 'getgid');

beforeAll(() => {
  // The managed test workspace has synthetic ancestor ownership. Path ownership is
  // covered by the storage package; this suite exercises restore reconciliation.
  Object.defineProperty(process, 'getuid', { configurable: true, value: undefined });
  Object.defineProperty(process, 'getgid', { configurable: true, value: undefined });
});

afterAll(() => {
  if (getuid) Object.defineProperty(process, 'getuid', getuid);
  if (getgid) Object.defineProperty(process, 'getgid', getgid);
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map(storage => storage.close()));
  for (const directory of scratch.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function open(directory: string, mode: 'create' | 'existing'): Promise<ConnectorStorage> {
  const storage = await openConnectorStorage({ directory, mode, limits: fx.limits });
  opened.push(storage);
  return storage;
}

/**
 * A ledger with one release whose dispatch began (`release_r7`) and one never dispatched
 * (`release_r8`), copied as a backup while closed and reopened from that copy.
 */
async function restoredLedger(): Promise<ConnectorStorage> {
  const { parent, state } = fx.scratchDirectory();
  scratch.push(parent);
  const storage = await open(state, 'create');
  await storage.ledger.transaction(tx => tx.putBinding(fx.binding(0)));
  for (const [eventId, body, commandId, releaseId, dispatched] of [
    ['event_7', 'hello', 'command_1', 'release_r7', true],
    ['event_8', 'later', 'command_2', 'release_r8', false],
  ] as const) {
    await storage.persistPending(fx.pendingInput(eventId, body));
    await storage.ledger.transaction(tx => {
      const command = fx.approval(commandId, [fx.eventRef(eventId, body)]);
      const payload = fx.content(`${body} envelope`);
      const job = fx.release(command, fx.binding(0), payload, releaseId);
      tx.putRelease({ command: fx.commandRecord(command, job.releaseId), job, payload, expectedLedgerRevision: tx.ledgerRevision() });
      if (dispatched) tx.appendReceipt({ receipt: fx.receipt(job.releaseId, 'dispatching') });
    });
  }
  await storage.close();
  opened.splice(opened.indexOf(storage), 1);
  const backup = path.join(parent, 'backup');
  fs.cpSync(state, backup, { recursive: true });
  return open(backup, 'existing');
}

function sweptReport(): RetentionReport {
  return { outcome: 'complete' } as RetentionReport;
}

describe('recovery lifecycle over a restored ledger', () => {
  it('AE1: keeps a release with an unknown outcome held and only asks for evidence about it', async () => {
    const storage = await restoredLedger();
    const reconcile = vi.fn(async () => undefined);
    const lifecycle = bindRecoveryLifecycle({
      ...storageRecoveryDeps({ storage, dispatcher: { reconcile }, bindingId: fx.bindingId }),
      binding: fx.binding(0),
    });

    await lifecycle.start();

    expect(lifecycle.observe()).toEqual({
      state: 'ready', reasons: [], unknownReleaseIds: ['release_r7'], undispatchedReleases: 1, staleGenerationPending: 0,
      cleanup: 'not_configured',
    });
    expect(reconcile.mock.calls).toEqual([['release_r7']]);
    // Restarting again changes nothing: the release stays unknown.
    await lifecycle.start();
    expect(lifecycle.observe().unknownReleaseIds).toEqual(['release_r7']);
  });

  it('blocks dispatch once the binding is revoked, and revocation survives the restore', async () => {
    const storage = await restoredLedger();
    await storage.ledger.transaction(tx => tx.putRevocation({
      targetKind: 'binding', targetId: fx.bindingId, generation: 0, operationId: 'op_revoke_1', revokedAt: '2026-09-18T10:03:00Z',
    }));
    const lifecycle = bindRecoveryLifecycle({
      ...storageRecoveryDeps({ storage, dispatcher: { reconcile: async () => undefined }, bindingId: fx.bindingId }),
      binding: fx.binding(0),
    });

    await lifecycle.start();

    expect(lifecycle.observe()).toMatchObject({ state: 'blocked', reasons: ['binding_revoked'], unknownReleaseIds: ['release_r7'] });
  });

  it('refuses a binding older than the generation the ledger already holds', async () => {
    const storage = await restoredLedger();
    await storage.ledger.transaction(tx => tx.putBinding(fx.binding(1)));
    const lifecycle = bindRecoveryLifecycle({
      ...storageRecoveryDeps({ storage, dispatcher: { reconcile: async () => undefined }, bindingId: fx.bindingId }),
      binding: fx.binding(0),
    });

    await lifecycle.start();

    expect(lifecycle.observe()).toMatchObject({ state: 'blocked', reasons: ['stale_generation'] });
  });
});

describe('recovery lifecycle ordering', () => {
  const inspection = {
    schemaVersion: 1, epoch: 1, ledgerRevision: 1, deviceIdentityBound: true, pending: 0, staleGenerationPending: 0,
    quarantined: 0, outcomeUnknownReleases: ['release_r7' as ReleaseId], undispatchedReleases: [], unavailable: 0,
    revokedBindings: [], uncorrelatedReceipts: 0, cursors: [], blocked: [],
  } as const;

  it('reports an unavailable inspection explicitly, never as ready', async () => {
    const lifecycle = bindRecoveryLifecycle({
      binding: fx.binding(0),
      inspect: async () => { throw new Error('ledger closed'); },
      ledgerGeneration: async () => 0,
      reconcileRelease: async () => undefined,
    });
    await lifecycle.start();
    expect(lifecycle.observe()).toMatchObject({ state: 'unavailable', unknownReleaseIds: [] });
  });

  it('refuses cleanup before reconciliation, then runs it even while dispatch is blocked', async () => {
    const sweep = vi.fn(async () => sweptReport());
    const lifecycle = bindRecoveryLifecycle({
      binding: fx.binding(0),
      inspect: async () => ({ ...inspection, revokedBindings: [fx.bindingId], blocked: ['revoked'] }),
      ledgerGeneration: async () => 0,
      reconcileRelease: async () => undefined,
      sweep,
    });
    expect(await lifecycle.cleanup()).toEqual({ kind: 'not_reconciled' });
    expect(sweep).not.toHaveBeenCalled();

    await lifecycle.start();
    expect(lifecycle.observe().state).toBe('blocked');
    expect(await lifecycle.cleanup()).toMatchObject({ kind: 'swept' });
    expect(lifecycle.observe()).toMatchObject({ state: 'blocked', cleanup: 'complete', unknownReleaseIds: ['release_r7'] });
  });

  it('reports a cleanup outage as failed while revoked authority stays enforced', async () => {
    const lifecycle = bindRecoveryLifecycle({
      binding: fx.binding(0),
      inspect: async () => ({ ...inspection, revokedBindings: [fx.bindingId], blocked: ['revoked'] }),
      ledgerGeneration: async () => 0,
      reconcileRelease: async () => undefined,
      sweep: async () => { throw new Error('disk unavailable'); },
    });
    await lifecycle.start();
    expect(await lifecycle.cleanup()).toEqual({ kind: 'failed' });
    expect(lifecycle.observe()).toMatchObject({ state: 'blocked', reasons: ['binding_revoked'], cleanup: 'failed' });
  });

  it('discards a reconciliation still in flight when stopped', async () => {
    let finish!: () => void;
    const lifecycle = bindRecoveryLifecycle({
      binding: fx.binding(0),
      inspect: () => new Promise(resolve => { finish = () => resolve(inspection); }),
      ledgerGeneration: async () => 0,
      reconcileRelease: async () => undefined,
    });
    const started = lifecycle.start();
    lifecycle.stop();
    finish();
    await started;
    expect(lifecycle.observe()).toMatchObject({ state: 'idle', unknownReleaseIds: [] });
  });
});

describe('registerRecovery', () => {
  function context(overrides: Partial<ConnectorCapabilityContext> = {}): ConnectorCapabilityContext {
    return {
      binding: fx.binding(0),
      ledger: {},
      dispatcher: { reconcilePending: async () => undefined, setEnabled: () => undefined, stop: vi.fn(async () => undefined) },
      clock: () => 0,
      prerequisiteChanged: () => undefined,
      ...overrides,
    };
  }

  it('stays unavailable without real storage', () => {
    expect(registerRecovery({ ...context(), dependencies: {} }).state).toBe('unavailable');
  });

  it('is ready only after reconciliation, and stopping leaves the shared dispatcher and ledger open', async () => {
    const storage = await restoredLedger();
    const ctx = context();
    const lifecycles: unknown[] = [];
    const capability = registerRecovery({
      ...ctx,
      dependencies: {
        lifecycle: () => storageRecoveryDeps({ storage, dispatcher: { reconcile: async () => undefined }, bindingId: fx.bindingId }),
        onLifecycle: lifecycle => lifecycles.push(lifecycle),
      },
    });
    expect(capability.state).toBe('unavailable');
    await capability.start();
    expect(capability.state).toBe('ready');
    await capability.stop();
    expect(capability.state).toBe('unavailable');
    expect(lifecycles.at(-1)).toBeNull();
    expect(ctx.dispatcher.stop).not.toHaveBeenCalled();
    expect(await storage.ledger.transaction(tx => tx.readBinding(fx.bindingId)?.generation)).toBe(0);
  });
});
