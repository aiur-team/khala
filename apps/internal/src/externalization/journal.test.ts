import fs from 'node:fs';
import path from 'node:path';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import type { DeviceId, OwnerId, ParticipantId, RoomId } from '@khala/contracts/messaging/index';
import type { ConversionOwner, ConversionStart } from '@khala/contracts/messaging/externalization';
import { rejected } from '@khala/contracts/messaging/outcomes';
import { afterEach, describe, expect, it } from 'vitest';
import { createChannelStore } from '../store/channel-store';
import { type InternalStoreHandle, openChannelStore } from '../store/open';
import { type ConversionEntry, createConversionJournal } from './journal';

const roots: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const owner = 'owner-ada' as OwnerId;
const ada: ConversionOwner = { ownerId: owner, participantId: 'participant-ada' as ParticipantId };
const channelId = 'internal-channel' as RoomId;
const destination = { idempotencyKey: 'conversion-1.destination', destinationChannelId: 'external-1', visibility: 'secret' } as const;
const start: ConversionStart = {
  v: 1, conversionId: 'conversion-1', operationId: 'op-start', sourceChannelId: channelId, historyMode: 'start_fresh',
  visibility: 'secret', agents: ['agent-1'],
};

function open(directory: string): InternalStoreHandle {
  const handle = openChannelStore({ directory, mode: fs.existsSync(directory) ? 'existing' : 'create' });
  closers.push(() => handle.close());
  return handle;
}

function fixture(): Readonly<{ directory: string; handle: InternalStoreHandle }> {
  const root = fs.mkdtempSync(path.join('/tmp', 'khala-conversion-journal-'));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  const directory = path.join(root, 'state');
  const handle = open(directory);
  const store = createChannelStore(handle);
  const human = 'participant-ada' as ParticipantId;
  const agent = 'agent-1' as ParticipantId;
  store.registerParticipant({ participantId: human, ownerId: owner, kind: 'human', displayName: 'Ada' });
  store.registerDevice({ deviceId: 'device-ada' as DeviceId, participantId: human });
  store.createChannel({
    operationId: 'create', channelId, title: 'Internal', creatorOwnerId: owner, creatorParticipantId: human,
    creatorDeviceId: 'device-ada' as DeviceId, createdAt: '2026-09-25T10:00:00.000Z',
  });
  store.registerParticipant({ participantId: agent, ownerId: owner, kind: 'agent', displayName: 'Agent' });
  store.registerDevice({ deviceId: 'device-agent' as DeviceId, participantId: agent });
  store.registerBinding({
    v: 1, bindingId: 'binding-agent' as SessionBinding['bindingId'], ownerId: owner, agentParticipantId: agent,
    deviceId: 'device-agent' as DeviceId, harness: 'codex', sessionId: 'session-agent', generation: 3,
  });
  store.setMembership({ channelId, participantId: agent, membership: 'joined' });
  return { directory, handle };
}

function entryOf(result: Awaited<ReturnType<ReturnType<typeof createConversionJournal>['start']>>): ConversionEntry {
  if (result.kind !== 'ok') throw new Error(JSON.stringify(result));
  return result.value;
}

describe('conversion journal', () => {
  it('snapshots the exact selected sessions and replays a start by operation ID', async () => {
    const { handle } = fixture();
    const journal = createConversionJournal(handle);
    const entry = entryOf(await journal.start(ada, start));
    expect(entry.snapshot).toMatchObject({
      owner: ada,
      sourceChannelId: channelId, visibility: 'secret', humans: ['participant-ada'],
      agents: [{ participantId: 'agent-1', harness: 'codex', sessionId: 'session-agent', generation: 3 }],
    });
    expect(await journal.start(ada, start)).toEqual({ kind: 'ok', value: entry });
    expect(await journal.start(ada, { ...start, visibility: 'public' })).toEqual(rejected('operation_mismatch'));
    expect(await journal.start(ada, { ...start, operationId: 'op-other', agents: [] })).toEqual(rejected('conflict'));
    expect(await journal.start(ada, { ...start, conversionId: 'c2', operationId: 'op-2', agents: ['participant-ada'] })).toEqual(rejected('conflict'));
  });

  it('refuses a selection that is not a joined agent with an active session', async () => {
    const { handle } = fixture();
    const journal = createConversionJournal(handle);
    expect(await journal.start(ada, { ...start, agents: ['participant-ada'] })).toEqual(rejected('invalid_selection'));
    expect(await journal.start(ada, { ...start, agents: ['agent-unknown'] })).toEqual(rejected('invalid_selection'));
    expect(await journal.start(ada, { ...start, sourceChannelId: 'missing' })).toEqual(rejected('not_found'));
  });

  it('starts only for a human participant of the owner of the source channel', async () => {
    const { handle } = fixture();
    const store = createChannelStore(handle);
    store.registerParticipant({ participantId: 'participant-mallory' as ParticipantId, ownerId: 'owner-mallory' as OwnerId, kind: 'human', displayName: 'M' });
    const journal = createConversionJournal(handle);
    const mallory: ConversionOwner = { ownerId: 'owner-mallory' as OwnerId, participantId: 'participant-mallory' as ParticipantId };
    expect(await journal.start(mallory, start)).toEqual(rejected('forbidden'));
    // The right owner with a participant that is not theirs, or is not human, is still not the owner.
    expect(await journal.start({ ownerId: owner, participantId: mallory.participantId }, start)).toEqual(rejected('forbidden'));
    expect(await journal.start({ ownerId: owner, participantId: 'agent-1' as ParticipantId }, start)).toEqual(rejected('forbidden'));
    expect(await journal.start({ ownerId: owner, participantId: 'participant-nobody' as ParticipantId }, start)).toEqual(rejected('forbidden'));
    expect(await journal.sourceLock(channelId)).toEqual({ kind: 'ok', value: null });
    entryOf(await journal.start(ada, start));
    // Replaying the owner's own start is refused too, and never returns the entry.
    expect(await journal.start(mallory, start)).toEqual(rejected('forbidden'));
  });

  it('implements the journal port: idempotent advance, stale writers lose, only listed transitions', async () => {
    const { handle } = fixture();
    const journal = createConversionJournal(handle);
    entryOf(await journal.start(ada, start));
    expect(await journal.create({ v: 1, conversionId: 'conversion-1', operationId: 'op-start', historyMode: 'start_fresh' }))
      .toMatchObject({ kind: 'ok', value: { state: 'preparing', revision: 0 } });
    expect(await journal.create({ v: 1, conversionId: 'other', operationId: 'op-new', historyMode: 'start_fresh' })).toEqual(rejected('operation_mismatch'));
    const skip = { v: 1, conversionId: 'conversion-1', operationId: 'op-a', expectedRevision: 0, from: 'preparing', to: 'committing' } as const;
    expect(await journal.advance(skip)).toEqual(rejected('invalid_transition'));
    const cancel = { ...skip, operationId: 'op-b', to: 'cancelled' } as const;
    const cancelled = await journal.advance(cancel);
    expect(cancelled).toMatchObject({ kind: 'ok', value: { state: 'cancelled', revision: 1 } });
    expect(await journal.advance(cancel)).toEqual(cancelled);
    expect(await journal.advance({ ...cancel, operationId: 'op-c' })).toEqual(rejected('stale_revision'));
    expect(await journal.advance({ ...cancel, to: 'failed' })).toEqual(rejected('operation_mismatch'));
  });

  it('survives a restart with the same record, destination and source lock', async () => {
    const { directory, handle } = fixture();
    const journal = createConversionJournal(handle);
    const entry = entryOf(await journal.start(ada, start));
    const created = await journal.change({ conversionId: 'conversion-1', operationId: 'op-created', expectedRevision: 0, to: 'external_created', destination });
    expect(created.kind).toBe('ok');
    handle.close();
    closers.length = 0;
    const reopened = createConversionJournal(open(directory));
    expect(await reopened.entry('conversion-1')).toMatchObject({
      kind: 'ok', value: { record: { state: 'external_created', revision: 1 }, destination, snapshot: entry.snapshot },
    });
    expect(await reopened.sourceLock(channelId)).toEqual({ kind: 'ok', value: { conversionId: 'conversion-1', write: 'open', destinationChannelId: null } });
  });

  it('commits the link state and the read-only source lock in one transaction', async () => {
    const { handle } = fixture();
    const journal = createConversionJournal(handle);
    entryOf(await journal.start(ada, start));
    let revision = 0;
    for (const to of ['external_created', 'agents_pending', 'committing'] as const) {
      const moved = await journal.change({
        conversionId: 'conversion-1', operationId: `op-${to}`, expectedRevision: revision, to,
        ...(to === 'external_created' ? { destination } : {}),
      });
      if (moved.kind !== 'ok') throw new Error(to);
      revision = moved.value.record.revision;
    }
    expect(await journal.sourceLock(channelId)).toMatchObject({ kind: 'ok', value: { write: 'paused' } });

    // Fail the conversion-record write, which follows the source-lock write: nothing of the link may land.
    handle.read(db => db.exec(`CREATE TEMP TRIGGER no_link BEFORE UPDATE ON control_records
      WHEN NEW.record_key = 'conversion.v1.conversion-1' BEGIN SELECT RAISE(ABORT, 'x'); END`));
    const link = { conversionId: 'conversion-1', operationId: 'op-link', expectedRevision: revision, to: 'activating' } as const;
    expect((await journal.change(link)).kind).toBe('unavailable');
    expect(await journal.read('conversion-1')).toMatchObject({ kind: 'ok', value: { state: 'committing', revision } });
    expect(await journal.sourceLock(channelId)).toMatchObject({ kind: 'ok', value: { write: 'paused' } });

    handle.read(db => db.exec('DROP TRIGGER temp.no_link'));
    expect(await journal.change(link)).toMatchObject({ kind: 'ok', value: { record: { state: 'activating' } } });
    expect(await journal.sourceLock(channelId)).toEqual({
      kind: 'ok', value: { conversionId: 'conversion-1', write: 'linked', destinationChannelId: 'external-1' },
    });
    expect(await journal.advance({ v: 1, conversionId: 'conversion-1', operationId: 'op-back', expectedRevision: revision + 1, from: 'activating', to: 'failed' }))
      .toEqual(rejected('invalid_transition'));
  });

  it('unfreezes the source when a paused conversion fails before the link', async () => {
    const { handle } = fixture();
    const journal = createConversionJournal(handle);
    entryOf(await journal.start(ada, start));
    let revision = 0;
    for (const to of ['external_created', 'agents_pending', 'committing', 'failed'] as const) {
      const moved = await journal.change({
        conversionId: 'conversion-1', operationId: `op-${to}`, expectedRevision: revision, to,
        ...(to === 'external_created' ? { destination } : {}),
      });
      if (moved.kind !== 'ok') throw new Error(to);
      revision = moved.value.record.revision;
    }
    expect(await journal.sourceLock(channelId)).toEqual({ kind: 'ok', value: null });
  });
});
