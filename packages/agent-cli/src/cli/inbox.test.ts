import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BindingId, EventRef } from '@khala/contracts/delivery/index';
import { CliError } from './errors.js';
import { openInbox } from './inbox.js';
import type { BatchInbox, InboxConsumer, WakeableInboxConsumer } from './inbox.js';
import type { InboxDelivery } from './types.js';

const roots: string[] = [];
const consumers: InboxConsumer[] = [];
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

function bindingDirectory(directory: string, generation = 3): string {
  const digest = createHash('sha256').update(JSON.stringify([bindingId, generation])).digest('base64url');
  return path.join(directory, 'bindings', digest);
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

function released(releaseId: string, body: string, generation = 3): InboxDelivery {
  const bytes = new TextEncoder().encode(body);
  return delivery({ releaseId, generation, payload: bytes, payloadDigest: digest(bytes) });
}

async function acquireBatch(inbox: BatchInbox): Promise<WakeableInboxConsumer> {
  const consumer = await inbox.acquireListener();
  consumers.push(consumer);
  return consumer;
}

afterEach(async () => {
  for (const consumer of consumers.splice(0).reverse()) await consumer.release().catch(() => undefined);
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
    const bindingDirectory = createHash('sha256').update(JSON.stringify([bindingId, 3])).digest('base64url');
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

  it('isolates cursor and records between binding generations', async () => {
    const directory = stateDirectory();
    const prior = await openInbox({
      stateDirectory: directory, bindingId, generation: 3, maxPayloadBytes: 1024, maxSelectionEvents: 32,
    });
    await prior.enqueue(delivery());
    const item = await prior.readNext();
    await prior.acknowledge(item!);

    const current = await openInbox({
      stateDirectory: directory, bindingId, generation: 4, maxPayloadBytes: 1024, maxSelectionEvents: 32,
    });
    expect(await current.readNext()).toBeNull();
    expect(await current.status()).toMatchObject({ generation: 4, cursor: { offset: 0, releaseId: null } });
    await expect(current.enqueue(delivery({ generation: 4 }))).resolves.toBe('appended');
  });

  it('rejects a generation directory that is not owner-only', async () => {
    const directory = stateDirectory();
    const generationDirectory = bindingDirectory(directory);
    fs.mkdirSync(generationDirectory, { recursive: true, mode: 0o700 });
    fs.chmodSync(generationDirectory, 0o755);

    await expect(openInbox({
      stateDirectory: directory, bindingId, generation: 3, maxPayloadBytes: 1024, maxSelectionEvents: 32,
    })).rejects.toEqual(new CliError('storage_failed'));
  });

  it('allows only one concurrent listener for a binding and releases ownership cleanly', async () => {
    const directory = stateDirectory();
    const first = await openInbox({ stateDirectory: directory, bindingId, generation: 3, maxPayloadBytes: 1024, maxSelectionEvents: 32 });
    const second = await openInbox({ stateDirectory: directory, bindingId, generation: 3, maxPayloadBytes: 1024, maxSelectionEvents: 32 });
    const attempts = await Promise.allSettled([first.acquireListener(), second.acquireListener()]);
    const acquired = attempts.filter(result => result.status === 'fulfilled');
    const rejected = attempts.filter(result => result.status === 'rejected');

    expect(acquired).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toEqual(new CliError('listener_busy'));
    await (acquired[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof first.acquireListener>>>).value.release();
    const replacement = await second.acquireListener();
    await replacement.release();
  });

  it('recovers an atomic listener lock left by a dead process', async () => {
    const directory = stateDirectory();
    const inbox = await openInbox({
      stateDirectory: directory, bindingId, generation: 3, maxPayloadBytes: 1024, maxSelectionEvents: 32,
    });
    const lockPath = path.join(bindingDirectory(directory), 'listener.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ v: 1, pid: 2_147_483_647, token: 'stale-owner' }) + '\n', { mode: 0o600 });
    fs.chmodSync(lockPath, 0o600);

    const held = await inbox.acquireListener();
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8'))).toMatchObject({ v: 1, pid: process.pid });
    await held.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('falls back to the private tmp socket root when the canonical path is too long', async () => {
    const directory = path.join(stateDirectory(), 'x'.repeat(120));
    const generationDirectory = bindingDirectory(directory);
    const directSocket = path.join(generationDirectory, 'listener.sock');
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const fallbackSocket = path.join(
      '/tmp',
      `.khala-agent-cli-${uid}`,
      `${createHash('sha256').update(generationDirectory).digest('hex').slice(0, 32)}.sock`,
    );
    expect(Buffer.byteLength(directSocket)).toBeGreaterThanOrEqual(100);
    const inbox = await openInbox({
      stateDirectory: directory, bindingId, generation: 3, maxPayloadBytes: 1024, maxSelectionEvents: 32,
    });

    const held = await inbox.acquireListener();
    expect(fs.existsSync(directSocket)).toBe(false);
    expect(fs.existsSync(fallbackSocket)).toBe(true);
    await held.release();
    expect(fs.existsSync(fallbackSocket)).toBe(false);
  });
});

describe('durable inbox batches', () => {
  it('requires the single-consumer lease for every batch transition', async () => {
    const directory = stateDirectory();
    const first = await openInbox({
      stateDirectory: directory, bindingId, generation: 3, maxPayloadBytes: 1024, maxSelectionEvents: 32,
    });
    const second = await openInbox({
      stateDirectory: directory, bindingId, generation: 3, maxPayloadBytes: 1024, maxSelectionEvents: 32,
    });
    const reader = await acquireBatch(first);
    await expect(second.acquireListener()).rejects.toEqual(new CliError('listener_busy'));
    await reader.release();
    await expect(reader.readBatch({ maxBytes: 1024 })).rejects.toEqual(new CliError('listener_busy'));
  });

  it('returns null for an empty inbox and stages at most eight FIFO records', async () => {
    const inbox = await openInbox({
      stateDirectory: stateDirectory(), bindingId, generation: 3, maxPayloadBytes: 1024, maxSelectionEvents: 32,
    });
    const reader = await acquireBatch(inbox);
    expect(await reader.readBatch({ maxBytes: 1024 })).toBeNull();
    for (let index = 1; index <= 10; index += 1) await inbox.enqueue(released(`release-${index}`, `body-${index}`));

    const batch = await reader.readBatch({ maxBytes: 1024 });
    expect(batch?.items.map(item => item.record.releaseId)).toEqual([
      'release-1', 'release-2', 'release-3', 'release-4', 'release-5', 'release-6', 'release-7', 'release-8',
    ]);
    expect((await inbox.status()).cursor).toEqual({ v: 1, offset: 0, releaseId: null });
  });

  it('uses the maximal whole-record byte prefix and permits one oversized head', async () => {
    const inbox = await openInbox({
      stateDirectory: stateDirectory(), bindingId, generation: 3, maxPayloadBytes: 1024, maxSelectionEvents: 32,
    });
    const reader = await acquireBatch(inbox);
    await inbox.enqueue(released('release-1', 'aa'));
    await inbox.enqueue(released('release-2', 'bbb'));
    await inbox.enqueue(released('release-3', 'cccc'));

    const exact = await reader.readBatch({ maxBytes: 5 });
    expect(exact?.items.map(item => item.record.releaseId)).toEqual(['release-1', 'release-2']);
    expect(exact?.items.map(item => item.payload.byteLength)).toEqual([2, 3]);

    const next = await reader.readBatch({ maxBytes: 1, acknowledgeToken: exact!.token });
    expect(next?.items.map(item => item.record.releaseId)).toEqual(['release-3']);
    expect(next?.items[0]?.payload.byteLength).toBe(4);
  });

  it('durably replays the identical outstanding batch until its exact token advances', async () => {
    const directory = stateDirectory();
    const first = await openInbox({
      stateDirectory: directory, bindingId, generation: 3, maxPayloadBytes: 1024, maxSelectionEvents: 32,
    });
    await first.enqueue(released('release-1', 'first'));
    await first.enqueue(released('release-2', 'second'));
    const firstReader = await acquireBatch(first);
    const staged = await firstReader.readBatch({ maxBytes: 1024 });
    expect(staged).not.toBeNull();
    expect((await first.status()).cursor.offset).toBe(0);
    const persisted = fs.readFileSync(path.join(bindingDirectory(directory), 'batch.json'));

    await first.enqueue(released('release-3', 'arrived-later'));
    await firstReader.release();
    const restarted = await openInbox({
      stateDirectory: directory, bindingId, generation: 3, maxPayloadBytes: 1024, maxSelectionEvents: 32,
    });
    const restartedReader = await acquireBatch(restarted);
    for (const acknowledgeToken of [undefined, 'foreign-token', staged!.token.slice(0, -1)]) {
      const replay = await restartedReader.readBatch({
        maxBytes: 1,
        ...(acknowledgeToken === undefined ? {} : { acknowledgeToken }),
      });
      expect(replay).toEqual(staged);
      expect(fs.readFileSync(path.join(bindingDirectory(directory), 'batch.json'))).toEqual(persisted);
      expect((await restarted.status()).cursor.offset).toBe(0);
    }

    const advanced = await restartedReader.readBatch({ maxBytes: 1024, acknowledgeToken: staged!.token });
    expect(advanced?.items.map(item => item.record.releaseId)).toEqual(['release-3']);
    expect((await restarted.status()).cursor.releaseId).toBe('release-2');
    expect(await restartedReader.readBatch({ maxBytes: 1, acknowledgeToken: staged!.token })).toEqual(advanced);
  });

  it('recovers an acknowledgement committed before outstanding-state cleanup', async () => {
    const directory = stateDirectory();
    const first = await openInbox({
      stateDirectory: directory, bindingId, generation: 3, maxPayloadBytes: 1024, maxSelectionEvents: 32,
    });
    await first.enqueue(released('release-1', 'first'));
    const firstReader = await acquireBatch(first);
    const batch = await firstReader.readBatch({ maxBytes: 1024 });
    const generationDirectory = bindingDirectory(directory);
    const state = JSON.parse(fs.readFileSync(path.join(generationDirectory, 'batch.json'), 'utf8')) as {
      endOffset: number; releaseId: string;
    };
    fs.writeFileSync(path.join(generationDirectory, 'cursor.json'), JSON.stringify({
      v: 1, offset: state.endOffset, releaseId: state.releaseId,
    }) + '\n', { mode: 0o600 });
    await firstReader.release();

    const restarted = await openInbox({
      stateDirectory: directory, bindingId, generation: 3, maxPayloadBytes: 1024, maxSelectionEvents: 32,
    });
    const restartedReader = await acquireBatch(restarted);
    expect(await restartedReader.readBatch({ maxBytes: 1024, acknowledgeToken: batch!.token })).toBeNull();
    expect(fs.existsSync(path.join(generationDirectory, 'batch.json'))).toBe(false);
  });

  it('fences acknowledgements by binding generation and rejects invalid byte budgets', async () => {
    const directory = stateDirectory();
    const prior = await openInbox({
      stateDirectory: directory, bindingId, generation: 3, maxPayloadBytes: 1024, maxSelectionEvents: 32,
    });
    await prior.enqueue(released('release-prior', 'prior'));
    const priorReader = await acquireBatch(prior);
    const priorBatch = await priorReader.readBatch({ maxBytes: 1024 });

    const current = await openInbox({
      stateDirectory: directory, bindingId, generation: 4, maxPayloadBytes: 1024, maxSelectionEvents: 32,
    });
    await current.enqueue(released('release-current', 'current', 4));
    const currentReader = await acquireBatch(current);
    const currentBatch = await currentReader.readBatch({ maxBytes: 1024, acknowledgeToken: priorBatch!.token });
    expect(currentBatch?.items.map(item => item.record.releaseId)).toEqual(['release-current']);
    expect((await current.status()).cursor.offset).toBe(0);
    await expect(currentReader.readBatch({ maxBytes: -1 })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(currentReader.readBatch({ maxBytes: 1.5 })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('fails closed for corrupt or invalid UTF-8 durable batch state', async () => {
    const directory = stateDirectory();
    const first = await openInbox({
      stateDirectory: directory, bindingId, generation: 3, maxPayloadBytes: 1024, maxSelectionEvents: 32,
    });
    await first.enqueue(released('release-1', 'first'));
    const firstReader = await acquireBatch(first);
    await firstReader.readBatch({ maxBytes: 1024 });
    fs.writeFileSync(path.join(bindingDirectory(directory), 'batch.json'), Buffer.from([0xff, 0xfe]), { mode: 0o600 });
    await firstReader.release();

    const restarted = await openInbox({
      stateDirectory: directory, bindingId, generation: 3, maxPayloadBytes: 1024, maxSelectionEvents: 32,
    });
    const restartedReader = await acquireBatch(restarted);
    await expect(restartedReader.readBatch({ maxBytes: 1024 })).rejects.toMatchObject({ code: 'storage_failed' });
  });

  it('fails closed for invalid UTF-8 in a complete inbox record', async () => {
    const directory = stateDirectory();
    const inbox = await openInbox({
      stateDirectory: directory, bindingId, generation: 3, maxPayloadBytes: 1024, maxSelectionEvents: 32,
    });
    await inbox.enqueue(released('release-1', 'first'));
    const reader = await acquireBatch(inbox);
    const inboxPath = path.join(bindingDirectory(directory), 'inbox.jsonl');
    const bytes = fs.readFileSync(inboxPath);
    const quote = bytes.indexOf(Buffer.from('release-1'));
    bytes[quote] = 0xff;
    fs.writeFileSync(inboxPath, bytes);

    await expect(reader.readBatch({ maxBytes: 1024 })).rejects.toMatchObject({ code: 'storage_failed' });
  });
});

async function settledWithin(promise: Promise<unknown>, ms = 100): Promise<boolean> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, ms));
  return settled;
}

function durableState(directory: string, generation = 3): Record<string, string | null> {
  const read = (name: string) => {
    const filename = path.join(bindingDirectory(directory, generation), name);
    return fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : null;
  };
  return { inbox: read('inbox.jsonl'), cursor: read('cursor.json'), batch: read('batch.json') };
}

function listenerSocket(directory: string, generation = 3): string {
  const generationDirectory = bindingDirectory(directory, generation);
  const direct = path.join(generationDirectory, 'listener.sock');
  if (Buffer.byteLength(direct) < 100) return direct;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return path.join(
    '/tmp',
    `.khala-agent-cli-${uid}`,
    `${createHash('sha256').update(generationDirectory).digest('hex').slice(0, 32)}.sock`,
  );
}

function open(directory: string, generation = 3): Promise<BatchInbox> {
  return openInbox({ stateDirectory: directory, bindingId, generation, maxPayloadBytes: 1024, maxSelectionEvents: 32 });
}

describe('listener notifier', () => {
  it('sends a zero-byte hint and only a clean zero-byte connection wakes the listener', async () => {
    const directory = stateDirectory();
    const inbox = await open(directory);
    const socketPath = listenerSocket(directory);
    const received: Buffer[] = [];
    const probe = net.createServer({ allowHalfOpen: true }, socket => {
      socket.on('data', chunk => received.push(chunk));
      socket.once('end', () => socket.end());
    });
    await new Promise<void>(resolve => probe.listen(socketPath, resolve));
    try {
      await expect(inbox.notifyListener()).resolves.toBe('notified');
    } finally {
      await new Promise<void>(resolve => probe.close(() => resolve()));
    }
    expect(Buffer.concat(received).byteLength).toBe(0);

    const listener = await acquireBatch(inbox);
    await listener.nextWake();
    const waiting = listener.nextWake();
    await new Promise<void>((resolve, reject) => {
      const intruder = net.createConnection(socketPath, () => intruder.end('release-1'));
      intruder.on('error', () => resolve());
      intruder.once('close', () => resolve());
      setTimeout(() => reject(new Error('intruder never closed')), 1000);
    });
    expect(await settledWithin(waiting)).toBe(false);
    await expect(inbox.notifyListener()).resolves.toBe('notified');
    await expect(waiting).resolves.toBeUndefined();
  });

  it('starts with one catch-up wake and coalesces pending hints into one', async () => {
    const inbox = await open(stateDirectory());
    const listener = await acquireBatch(inbox);

    await expect(listener.nextWake()).resolves.toBeUndefined();
    expect(await settledWithin(listener.nextWake())).toBe(false);
    await listener.release();

    const restarted = await acquireBatch(inbox);
    await restarted.nextWake();
    for (let index = 0; index < 5; index += 1) await expect(inbox.notifyListener()).resolves.toBe('notified');
    await expect(restarted.nextWake()).resolves.toBeUndefined();
    expect(await settledWithin(restarted.nextWake())).toBe(false);
  });

  it('fails closed without a live listener and leaves durable state untouched', async () => {
    const directory = stateDirectory();
    const inbox = await open(directory);
    await inbox.enqueue(released('release-1', 'first'));
    const before = durableState(directory);

    await expect(inbox.notifyListener()).resolves.toBe('unavailable');

    // A listener that died without cleanup leaves its socket file behind.
    const socketPath = listenerSocket(directory);
    const orphan = spawnSync(process.execPath, [
      '-e',
      'require("node:net").createServer().listen(process.argv[1], () => process.exit(0))',
      socketPath,
    ]);
    expect(orphan.status).toBe(0);
    expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
    await expect(inbox.notifyListener()).resolves.toBe('unavailable');
    fs.rmSync(socketPath);
    expect(durableState(directory)).toEqual(before);
  });

  it('wakes only the listener of its own binding generation', async () => {
    const directory = stateDirectory();
    const current = await open(directory, 3);
    const other = await open(directory, 4);
    const currentListener = await acquireBatch(current);
    const otherListener = await acquireBatch(other);
    await currentListener.nextWake();
    await otherListener.nextWake();

    const currentWake = currentListener.nextWake();
    await expect(other.notifyListener()).resolves.toBe('notified');
    await expect(otherListener.nextWake()).resolves.toBeUndefined();
    expect(await settledWithin(currentWake)).toBe(false);
  });

  it('recovers a crash between append and hint with one catch-up and no second record or token', async () => {
    const directory = stateDirectory();
    const beforeCrash = await open(directory);
    await expect(beforeCrash.enqueue(released('release-1', 'first'))).resolves.toBe('appended');
    const stored = durableState(directory).inbox;

    const restarted = await open(directory);
    await expect(restarted.enqueue(released('release-1', 'first'))).resolves.toBe('duplicate');
    const listener = await acquireBatch(restarted);
    await expect(restarted.notifyListener()).resolves.toBe('notified');
    await listener.nextWake();
    expect(await settledWithin(listener.nextWake())).toBe(false);
    const batch = await listener.readBatch({ maxBytes: 1024 });
    expect(batch?.items.map(item => item.record.releaseId)).toEqual(['release-1']);
    await listener.release();

    const reconnected = await acquireBatch(await open(directory));
    await reconnected.nextWake();
    expect(await reconnected.readBatch({ maxBytes: 1024 })).toEqual(batch);
    expect(durableState(directory).inbox).toBe(stored);
    expect(JSON.parse(durableState(directory).cursor ?? '{"offset":0}').offset).toBe(0);
  });

  it('revokes wake authority when the listener is released', async () => {
    const inbox = await open(stateDirectory());
    const listener = await acquireBatch(inbox);
    await listener.nextWake();
    const revoked = expect(listener.nextWake()).rejects.toEqual(new CliError('listener_busy'));

    await listener.release();
    await revoked;
    await expect(listener.nextWake()).rejects.toEqual(new CliError('listener_busy'));
    await expect(inbox.notifyListener()).resolves.toBe('unavailable');
  });

  it('keeps the long-path fallback socket private to the inbox', async () => {
    const inbox = await open(path.join(stateDirectory(), 'x'.repeat(120)));
    const listener = await acquireBatch(inbox);
    await listener.nextWake();

    const outcome = await inbox.notifyListener();
    expect(outcome).toBe('notified');
    await expect(listener.nextWake()).resolves.toBeUndefined();
  });
});
