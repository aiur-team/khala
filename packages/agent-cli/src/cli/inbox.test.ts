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
    const inbox = await openInbox({ stateDirectory: stateDirectory(), bindingId, generation: 3, maxPayloadBytes: 1024, maxSelectionEvents: 32 });

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
    const first = await openInbox({ stateDirectory: directory, bindingId, generation: 3, maxPayloadBytes: 1024, maxSelectionEvents: 32 });
    await first.enqueue(delivery());
    const item = await first.readNext();
    expect(item).not.toBeNull();
    await first.acknowledge(item!);

    const restarted = await openInbox({ stateDirectory: directory, bindingId, generation: 3, maxPayloadBytes: 1024, maxSelectionEvents: 32 });
    expect(await restarted.readNext()).toBeNull();
    expect(await restarted.status()).toMatchObject({ bindingId, generation: 3, cursor: { releaseId: 'release-1' } });
    expect(await restarted.enqueue(delivery())).toBe('duplicate');
  });

  it('truncates an incomplete trailing line without advancing the cursor', async () => {
    const directory = stateDirectory();
    const first = await openInbox({ stateDirectory: directory, bindingId, generation: 3, maxPayloadBytes: 1024, maxSelectionEvents: 32 });
    await first.enqueue(delivery());
    const item = await first.readNext();
    await first.acknowledge(item!);
    const bindingDirectory = createHash('sha256').update(bindingId).digest('base64url');
    fs.appendFileSync(path.join(directory, 'bindings', bindingDirectory, 'inbox.jsonl'), '{"v":1,"releaseId":"partial');

    const restarted = await openInbox({ stateDirectory: directory, bindingId, generation: 3, maxPayloadBytes: 1024, maxSelectionEvents: 32 });
    expect(await restarted.readNext()).toBeNull();
    await restarted.enqueue(delivery({ releaseId: 'release-2' }));
    expect((await restarted.readNext())?.record.releaseId).toBe('release-2');
  });

  it('rejects digest, payload bound and binding fence violations with closed errors', async () => {
    const inbox = await openInbox({ stateDirectory: stateDirectory(), bindingId, generation: 3, maxPayloadBytes: payload.byteLength, maxSelectionEvents: 32 });
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

  it('bounds event selections and rejects calendar-invalid timestamps', async () => {
    const inbox = await openInbox({
      stateDirectory: stateDirectory(), bindingId, generation: 3, maxPayloadBytes: 1024, maxSelectionEvents: 1,
    });
    await expect(inbox.enqueue(delivery({ events: [event, { ...event, eventId: 'event-2' as EventRef['eventId'] }] })))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(inbox.enqueue(delivery({ receivedAt: '2026-02-31T12:00:00Z' })))
      .rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('never uses an opaque binding identifier as a filesystem path', async () => {
    const directory = stateDirectory();
    const hostile = '../outside' as BindingId;
    const inbox = await openInbox({
      stateDirectory: directory, bindingId: hostile, generation: 3, maxPayloadBytes: 1024, maxSelectionEvents: 32,
    });
    await inbox.enqueue(delivery({ bindingId: hostile }));
    expect(fs.existsSync(path.join(directory, 'outside'))).toBe(false);
  });

  it('allows only one listener for a binding and releases ownership cleanly', async () => {
    const directory = stateDirectory();
    const first = await openInbox({ stateDirectory: directory, bindingId, generation: 3, maxPayloadBytes: 1024, maxSelectionEvents: 32 });
    const second = await openInbox({ stateDirectory: directory, bindingId, generation: 3, maxPayloadBytes: 1024, maxSelectionEvents: 32 });
    const held = await first.acquireListener();

    await expect(second.acquireListener()).rejects.toEqual(new CliError('listener_busy'));
    await held.release();
    const replacement = await second.acquireListener();
    await replacement.release();
  });
});
