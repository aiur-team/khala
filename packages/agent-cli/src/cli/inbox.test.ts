import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BindingId, EventRef } from '@khala/contracts/delivery/index';
import { CliError } from './errors.js';
import { openInbox } from './inbox.js';
import type { InboxDelivery } from './types.js';

const roots: string[] = [];
const bindingId = 'binding-1' as BindingId;
const payload = new TextEncoder().encode('released payload');
const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const event: EventRef = {
  v: 1,
  roomId: 'room-1' as EventRef['roomId'],
  eventId: 'event-1' as EventRef['eventId'],
  authorParticipantId: 'participant-1' as EventRef['authorParticipantId'],
  authorDeviceId: 'device-1' as EventRef['authorDeviceId'],
  contentDigest: digest(new TextEncoder().encode('source event')),
};

function stateDirectory(): string {
  const parent = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'khala-inbox-'));
  roots.push(parent);
  return path.join(parent, 'state');
}

function delivery(overrides: Partial<InboxDelivery> = {}): InboxDelivery {
  return {
    v: 1,
    releaseId: 'release-1',
    bindingId,
    generation: 3,
    events: [event],
    payloadDigest: digest(payload),
    payload,
    receivedAt: '2026-09-19T12:00:00Z',
    ...overrides,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('durable inbox', () => {
  it('appends once, decodes the payload and deduplicates a release', async () => {
    const inbox = await openInbox({ stateDirectory: stateDirectory(), bindingId, generation: 3, maxPayloadBytes: 1024 });

    await expect(inbox.enqueue(delivery({ receivedAt: '2026-09-19T12:00:00.123Z' }))).resolves.toBe('appended');
    await expect(inbox.enqueue(delivery({ receivedAt: '2026-09-19T12:00:00.123Z' }))).resolves.toBe('duplicate');
    const item = await inbox.readNext();
    expect(item?.record).toMatchObject({
      v: 1, releaseId: 'release-1', bindingId, generation: 3, events: [event], receivedAt: '2026-09-19T12:00:00.123Z',
    });
    expect(item?.payload).toEqual(payload);
  });

  it('persists acknowledgements across restart without redelivering', async () => {
    const directory = stateDirectory();
    const first = await openInbox({ stateDirectory: directory, bindingId, generation: 3, maxPayloadBytes: 1024 });
    await first.enqueue(delivery());
    const item = await first.readNext();
    expect(item).not.toBeNull();
    await first.acknowledge(item!);

    const restarted = await openInbox({ stateDirectory: directory, bindingId, generation: 3, maxPayloadBytes: 1024 });
    expect(await restarted.readNext()).toBeNull();
    expect(await restarted.status()).toMatchObject({ bindingId, generation: 3, cursor: { releaseId: 'release-1' } });
    expect(await restarted.enqueue(delivery())).toBe('duplicate');
  });

  it('truncates an incomplete trailing line without advancing the cursor', async () => {
    const directory = stateDirectory();
    const first = await openInbox({ stateDirectory: directory, bindingId, generation: 3, maxPayloadBytes: 1024 });
    await first.enqueue(delivery());
    const item = await first.readNext();
    await first.acknowledge(item!);
    fs.appendFileSync(path.join(directory, 'bindings', bindingId, 'inbox.jsonl'), '{"v":1,"releaseId":"partial');

    const restarted = await openInbox({ stateDirectory: directory, bindingId, generation: 3, maxPayloadBytes: 1024 });
    expect(await restarted.readNext()).toBeNull();
    await restarted.enqueue(delivery({ releaseId: 'release-2' }));
    expect((await restarted.readNext())?.record.releaseId).toBe('release-2');
  });

  it('rejects digest, payload bound and binding fence violations with closed errors', async () => {
    const inbox = await openInbox({ stateDirectory: stateDirectory(), bindingId, generation: 3, maxPayloadBytes: payload.byteLength });
    for (const invalid of [
      delivery({ payloadDigest: `sha256:${'0'.repeat(64)}` }),
      delivery({ payload: new Uint8Array(payload.byteLength + 1) }),
      delivery({ bindingId: 'binding-other' as BindingId }),
      delivery({ generation: 4 }),
    ]) {
      await expect(inbox.enqueue(invalid)).rejects.toEqual(expect.objectContaining({ name: 'CliError', code: 'invalid_input' }));
    }
    expect(await inbox.readNext()).toBeNull();
  });

  it('allows only one listener for a binding and releases ownership cleanly', async () => {
    const directory = stateDirectory();
    const first = await openInbox({ stateDirectory: directory, bindingId, generation: 3, maxPayloadBytes: 1024 });
    const second = await openInbox({ stateDirectory: directory, bindingId, generation: 3, maxPayloadBytes: 1024 });
    const held = await first.acquireListener();

    await expect(second.acquireListener()).rejects.toEqual(new CliError('listener_busy'));
    await held.release();
    const replacement = await second.acquireListener();
    await replacement.release();
  });
});
