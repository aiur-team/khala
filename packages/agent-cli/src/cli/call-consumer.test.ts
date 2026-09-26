import { describe, expect, it, vi } from 'vitest';
import { acquireListenerWithin, callScopedConsumer } from './call-consumer.js';
import { CliError } from './errors.js';
import type { BatchInbox, InboxConsumer } from './inbox.js';

function inbox(acquireListener: () => Promise<InboxConsumer>): BatchInbox {
  return {
    async enqueue() { return 'appended'; },
    async acquireListener() { return { ...await acquireListener(), async nextWake() {} }; },
    async notifyListener() { return 'unavailable'; },
    async readNext() { return null; },
    async acknowledge() {},
    async status() { throw new Error('unused'); },
  };
}

describe('call-scoped listener', () => {
  it('waits for another short-lived consumer and releases after each selection', async () => {
    const release = vi.fn(async () => undefined);
    const readBatch = vi.fn(async () => null);
    const acquire = vi.fn<() => Promise<InboxConsumer>>()
      .mockRejectedValueOnce(new CliError('listener_busy'))
      .mockResolvedValue({ readBatch, release });
    const consumer = callScopedConsumer(inbox(acquire), { waitMs: 1_000 });

    await consumer.readBatch({ maxBytes: 1 });
    await consumer.readBatch({ maxBytes: 1, acknowledgeToken: 'token' });

    expect(acquire).toHaveBeenCalledTimes(3);
    expect(release).toHaveBeenCalledTimes(2);
    expect(readBatch).toHaveBeenLastCalledWith({ maxBytes: 1, acknowledgeToken: 'token' });
  });

  it('releases the listener when selection fails', async () => {
    const release = vi.fn(async () => undefined);
    const consumer = callScopedConsumer(inbox(async (): Promise<InboxConsumer> => ({
      async readBatch() { throw new CliError('storage_failed'); }, release,
    })));
    await expect(consumer.readBatch({ maxBytes: 1 })).rejects.toEqual(new CliError('storage_failed'));
    expect(release).toHaveBeenCalledOnce();
  });

  it('gives up with listener_busy after the bounded wait and fails other errors at once', async () => {
    const busy = vi.fn(async (): Promise<InboxConsumer> => { throw new CliError('listener_busy'); });
    await expect(acquireListenerWithin(inbox(busy), { waitMs: 60 })).rejects.toEqual(new CliError('listener_busy'));
    expect(busy.mock.calls.length).toBeGreaterThan(1);

    const broken = vi.fn(async (): Promise<InboxConsumer> => { throw new CliError('storage_failed'); });
    await expect(acquireListenerWithin(inbox(broken), { waitMs: 1_000 })).rejects.toEqual(new CliError('storage_failed'));
    expect(broken).toHaveBeenCalledOnce();
  });
});
