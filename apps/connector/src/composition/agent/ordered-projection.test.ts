import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { encodeMessageContent } from '@khala/contracts/messaging/events';
import { openConnectorStorage } from '@khala/connector/storage/open';
import { readOrderedPendingReferences } from '@khala/connector/storage/ordered-pending';
import { createOrderedProjection } from './ordered-projection';
import type { LocalInbox } from './hosted-codex';

type Delivery = Parameters<LocalInbox['enqueue']>[0];
const directories: string[] = [];
const getuid = Object.getOwnPropertyDescriptor(process, 'getuid');
const getgid = Object.getOwnPropertyDescriptor(process, 'getgid');
beforeAll(() => {
  Object.defineProperty(process, 'getuid', { configurable: true, value: undefined });
  Object.defineProperty(process, 'getgid', { configurable: true, value: undefined });
});
afterAll(() => {
  if (getuid) Object.defineProperty(process, 'getuid', getuid);
  if (getgid) Object.defineProperty(process, 'getgid', getgid);
});
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function journal() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ordered-projection-'));
  directories.push(directory);
  return path.join(directory, 'projection.json');
}
const ref = (id: string) => ({ v: 1 as const, roomId: 'room_one' as never, eventId: id as never,
  authorParticipantId: 'agent_one' as never, authorDeviceId: 'DEVICE_ONE' as never, contentDigest: `sha256:${'a'.repeat(64)}` });
function release(ids: string[], releaseId = 'release_one'): Delivery {
  const events = ids.map(ref);
  return { v: 1, bindingId: 'binding_one', generation: 1, releaseId, events, receivedAt: '2026-09-29T00:00:00Z',
    payloadDigest: `sha256:${'b'.repeat(64)}`, payload: Buffer.from(JSON.stringify(['khala.release.v1', releaseId, 'binding_one', 1, 1,
      events.map(event => [event.roomId, event.eventId, event.authorParticipantId, event.authorDeviceId, event.contentDigest, `private-${event.eventId}`])])) };
}
function metadata(id: string): Delivery {
  return { ...release([id], `rename_${'c'.repeat(64)}`), payload: Buffer.from(JSON.stringify(['khala.agent-rename.v1', 'room_one', id, 'human_one', 'agent_one', 'Dolan'])) };
}
function inbox() {
  const deliveries: Delivery[] = [];
  const port: LocalInbox = { async enqueue(delivery) {
    if (deliveries.some(item => item.releaseId === delivery.releaseId)) return 'duplicate';
    deliveries.push(delivery); return 'appended';
  }, async notifyListener() { return 'notified'; } };
  return { deliveries, port };
}

describe('durable ordered agent projection', () => {
  it('allows an approved later event through a manual inbox without waking a model', async () => {
    const projection = createOrderedProjection(await journal(), { manualRead: true });
    const notified: string[] = [];
    const sink = inbox();
    const manual = { ...sink.port, async notifyListener(reason: 'released') {
      notified.push(reason); return 'notified' as const;
    } };
    await projection.observe('room_one', 'A', 'Owner');
    await projection.observe('room_one', 'B', 'Owner');
    await projection.enqueue(release(['B'], 'release_B'), manual);
    expect(sink.deliveries.map(item => item.events[0]!.eventId)).toEqual(['B']);
    expect(notified).toEqual([]);
    expect(await projection.acknowledge([sink.deliveries[0]!.releaseId])).toEqual(['release_B']);
    expect(await projection.enqueue(release(['B'], 'release_B'), manual)).toBe('duplicate');
    expect(sink.deliveries).toHaveLength(1);
  });
  it('upgrades committed legacy pending intake before later renames using ledger order despite reversed timestamps', async () => {
    const filename = await journal();
    const directory = path.join(path.dirname(filename), 'legacy-state');
    const binding = { v: 1 as const, bindingId: 'binding_one' as never, generation: 1, ownerId: 'owner_one' as never,
      agentParticipantId: 'agent_one' as never, deviceId: 'DEVICE_ONE' as never, harness: 'codex', sessionId: 'session_one' };
    const options = { directory, limits: { maxSelectionEvents: 20, maxPayloadBytes: 64 * 1024 } as never };
    let storage = await openConnectorStorage({ ...options, mode: 'create' });
    await storage.bindDeviceIdentity({ deviceId: binding.deviceId, fingerprint: 'fingerprint_one' });
    await storage.ledger.transaction(tx => tx.putBinding(binding));
    for (const [index, eventId] of ['legacy-first', 'legacy-second'].entries()) {
      const plaintext = encodeMessageContent({ v: 1, kind: 'text', body: `held-secret-${eventId}` });
      const event = { ...ref(eventId), contentDigest: `sha256:${createHash('sha256').update(plaintext).digest('hex')}` };
      await storage.persistPending({ event, plaintext, streamId: 'legacy-stream',
        key: { roomId: event.roomId, eventId: event.eventId, recipientBindingId: binding.bindingId, recipientGeneration: 1 },
        receivedAt: index === 0 ? '2026-09-29T00:00:00Z' : '2026-09-28T00:00:00Z' });
    }
    await storage.commitCursor({ streamId: 'legacy-stream', expectedRevision: 0, opaqueCursor: 'committed-after-two' });
    await storage.close();
    storage = await openConnectorStorage({ ...options, mode: 'existing' });
    const references = readOrderedPendingReferences(storage, binding);
    expect(references.map(item => item.eventId)).toEqual(['legacy-first', 'legacy-second']);
    const projection = createOrderedProjection(filename);
    await projection.seedLegacy(references);
    const sink = inbox();
    await projection.metadata(metadata('new-rename'), sink.port);
    expect(sink.deliveries).toHaveLength(0);
    expect(await readFile(filename, 'utf8')).not.toContain('held-secret');
    await projection.enqueue(release(['legacy-second'], 'release_second'), sink.port);
    expect(sink.deliveries).toHaveLength(0);
    await projection.enqueue(release(['legacy-first'], 'release_first'), sink.port);
    expect(sink.deliveries.map(item => item.events[0]!.eventId)).toEqual(['legacy-first', 'legacy-second', 'new-rename']);
    await createOrderedProjection(filename).seedLegacy(references);
    await storage.close();
  });

  it('does not hold new metadata behind legacy messages already accepted by the inbox', async () => {
    const projection = createOrderedProjection(await journal());
    const sink = inbox();
    await projection.seedLegacy([{ roomId: 'room_one', eventId: 'already-delivered', authorParticipantId: 'human_one', ledgerRevision: 1, previouslyDelivered: true }]);
    await projection.metadata(metadata('rename'), sink.port);
    expect(sink.deliveries.map(item => item.events[0]!.eventId)).toEqual(['rename']);
  });

  it('holds a rename behind unreleased text without storing its body, then recovers after restart', async () => {
    const filename = await journal();
    let projection = createOrderedProjection(filename);
    const sink = inbox();
    await projection.observe('room_one', 'before', 'Codex #420');
    await projection.metadata(metadata('rename'), sink.port);
    expect(sink.deliveries).toHaveLength(0);
    expect(await readFile(filename, 'utf8')).not.toContain('private-before');
    projection = createOrderedProjection(filename);
    await projection.enqueue(release(['before']), sink.port);
    expect(sink.deliveries.map(item => item.events[0]!.eventId)).toEqual(['before', 'rename']);
    expect(JSON.parse(Buffer.from(sink.deliveries[0]!.payload).toString())[5][0][6]).toBe('Codex #420');
    expect(await projection.enqueue(release(['before']), sink.port)).toBe('duplicate');
    expect(sink.deliveries).toHaveLength(2);
    await expect(projection.enqueue({ ...release(['before']), payload: Buffer.from('changed') }, sink.port)).rejects.toThrow('ordered_projection_conflict');
  });

  it('interleaves a rename inside one selected release and acknowledges only the complete original release', async () => {
    const filename = await journal();
    const projection = createOrderedProjection(filename);
    const sink = inbox();
    await projection.observe('room_one', 'before', 'Codex #420');
    await projection.metadata(metadata('rename'), sink.port);
    await projection.observe('room_one', 'after', 'Dolan');
    await projection.enqueue(release(['before', 'after']), sink.port);
    expect(sink.deliveries.map(item => item.events[0]!.eventId)).toEqual(['before', 'rename', 'after']);
    expect(sink.deliveries.filter(item => item.releaseId.startsWith('projection_')).map(item => JSON.parse(Buffer.from(item.payload).toString())[5][0][6])).toEqual(['Codex #420', 'Dolan']);
    expect(await projection.acknowledge([sink.deliveries[0]!.releaseId, sink.deliveries[1]!.releaseId])).toEqual([]);
    const restarted = createOrderedProjection(filename);
    expect(await restarted.acknowledge([sink.deliveries[2]!.releaseId])).toEqual(['release_one']);
    expect(await restarted.acknowledge([sink.deliveries[2]!.releaseId])).toEqual(['release_one']);
  });

  it('recovers a crash after inbox append before marking delivered without duplication or reordering', async () => {
    const filename = await journal();
    const projection = createOrderedProjection(filename);
    const sink = inbox();
    await projection.observe('room_one', 'before', 'Scout');
    await projection.metadata(metadata('rename'), sink.port);
    let crashed = false;
    const crashing: LocalInbox = { ...sink.port, async enqueue(delivery) {
      const result = await sink.port.enqueue(delivery);
      if (!crashed) { crashed = true; throw new Error('process stopped after append'); }
      return result;
    } };
    await expect(projection.enqueue(release(['before']), crashing)).rejects.toThrow('process stopped');
    await createOrderedProjection(filename).flush(sink.port);
    expect(sink.deliveries.map(item => item.events[0]!.eventId)).toEqual(['before', 'rename']);
  });
});
