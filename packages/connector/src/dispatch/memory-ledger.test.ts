import { describe, expect, it } from 'vitest';
import { createMemoryLedger, type MemoryTx } from './fixtures/memory-ledger';
import { makeRelease, recordOf } from './fixtures/fakes';
import { queuedRecord } from './claim';

describe('memory reference ledger', () => {
  it('commits nothing from a transaction that throws', async () => {
    const ledger = createMemoryLedger();
    const { job } = makeRelease({ releaseId: 'release-1' });
    await expect(ledger.transact(tx => {
      tx.put(queuedRecord(job, tx.nextSeq()));
      tx.setCausalCount(job.causalRootId, 1);
      throw new Error('abort');
    })).rejects.toThrow('abort');
    expect(await recordOf(ledger, 'release-1')).toBeNull();
    expect(await ledger.transact(tx => [tx.nextSeq(), tx.causalCount(job.causalRootId), tx.releaseFor(job.approval.commandId)]))
      .toEqual([1, 0, null]);
  });

  it('refuses a transaction whose work is asynchronous, and commits none of its writes', async () => {
    const ledger = createMemoryLedger();
    const { job } = makeRelease({ releaseId: 'release-1' });
    let late: Promise<void> | null = null;
    const work = (tx: MemoryTx) => {
      late = (async () => {
        await Promise.resolve();
        tx.put(queuedRecord(job, 1));
      })();
      return late;
    };
    await expect(ledger.transact(work)).rejects.toThrow('synchronous');
    await expect(late).rejects.toThrow('transaction closed');
    expect(await recordOf(ledger, 'release-1')).toBeNull();
  });

  it('closes a transaction handle once its transaction ends', async () => {
    const ledger = createMemoryLedger();
    const { job } = makeRelease({ releaseId: 'release-1' });
    const leaked = await ledger.transact(tx => tx);
    expect(() => leaked.put(queuedRecord(job, 1))).toThrow('transaction closed');
    expect(await recordOf(ledger, 'release-1')).toBeNull();
  });
});
