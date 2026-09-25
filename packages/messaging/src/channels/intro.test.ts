import { describe, expect, it } from 'vitest';
import { type DeviceId, digestMessageContent } from '@khala/contracts/messaging/index';
import { agent, harness, text } from './fixtures/fakes';

const messages = [text('Hi, I am Ada.'), text('This is my agent.'), text('It will summarise the thread.')];

describe('channel intro batches', () => {
  it('sends every item in order and reports one accepted state per message', async () => {
    const { service, substrate } = harness();
    const room = substrate.addRoom();
    const result = await service.prepareIntro({ roomId: room.roomId, batchId: 'batch-1', messages });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.map(state => state.state)).toEqual(['accepted', 'accepted', 'accepted']);
    expect(substrate.landed.map(event => event.content.body)).toEqual(messages.map(message => message.body));
    const digest = await digestMessageContent(messages[0]!);
    expect(result.value[0]?.eventRef).toMatchObject({ roomId: room.roomId, authorParticipantId: 'p-human', contentDigest: digest.ok && digest.digest });
  });

  it('resumes a second-item failure by sending only the unresolved items with their original transactions', async () => {
    const { service, substrate } = harness();
    const room = substrate.addRoom();
    substrate.sendMode = (txn, attempt) => (txn === 'txn-2' && attempt === 0 ? 'unavailable' : 'accept');
    const first = await service.prepareIntro({ roomId: room.roomId, batchId: 'batch-2', messages });
    expect(first).toMatchObject({ kind: 'ok', value: [{ state: 'accepted' }, { state: 'failed' }, { state: 'pending' }] });

    const resumed = await service.resumeIntro('batch-2');
    expect(resumed).toMatchObject({ kind: 'ok', value: [{ state: 'accepted' }, { state: 'accepted' }, { state: 'accepted' }] });
    expect(substrate.sendCalls).toEqual([
      { clientTxnId: 'txn-1', body: messages[0]!.body },
      { clientTxnId: 'txn-2', body: messages[1]!.body },
      { clientTxnId: 'txn-2', body: messages[1]!.body },
      { clientTxnId: 'txn-3', body: messages[2]!.body },
    ]);
    expect(substrate.landed).toHaveLength(3);
  });

  it('resolves a lost third response by re-sending its transaction without duplicating the first two (AE1)', async () => {
    const { service, substrate } = harness();
    const room = substrate.addRoom();
    substrate.sendMode = (txn, attempt) => (txn === 'txn-3' && attempt === 0 ? 'lose' : 'accept');
    const first = await service.prepareIntro({ roomId: room.roomId, batchId: 'batch-3', messages });
    expect(first).toMatchObject({ kind: 'ok', value: [{ state: 'accepted' }, { state: 'accepted' }, { state: 'outcome_unknown', eventRef: null }] });

    // Preparing the identical selection again is a resume, not a second batch.
    const resumed = await service.prepareIntro({ roomId: room.roomId, batchId: 'batch-3', messages });
    expect(resumed).toMatchObject({ kind: 'ok', value: [{ state: 'accepted' }, { state: 'accepted' }, { state: 'accepted' }] });
    expect(substrate.sendCalls.map(call => call.clientTxnId)).toEqual(['txn-1', 'txn-2', 'txn-3', 'txn-3']);
    expect(substrate.landed).toHaveLength(3);
  });

  it('never appends a late message to an approved batch', async () => {
    const { service, substrate } = harness();
    const room = substrate.addRoom();
    substrate.sendMode = txn => (txn === 'txn-1' ? 'unavailable' : 'accept');
    await service.prepareIntro({ roomId: room.roomId, batchId: 'batch-4', messages: messages.slice(0, 2) });
    const extended = await service.prepareIntro({ roomId: room.roomId, batchId: 'batch-4', messages });
    const reordered = await service.prepareIntro({ roomId: room.roomId, batchId: 'batch-4', messages: [messages[1]!, messages[0]!] });
    expect(extended).toEqual({ kind: 'rejected', code: 'operation_mismatch' });
    expect(reordered).toEqual({ kind: 'rejected', code: 'operation_mismatch' });
    expect(substrate.sendCalls.map(call => call.clientTxnId)).toEqual(['txn-1']);
  });

  it('keeps delegated-agent authorship on every intro item', async () => {
    const { service, substrate } = harness({ actor: agent });
    const room = substrate.addRoom();
    const result = await service.prepareIntro({ roomId: room.roomId, batchId: 'batch-agent', messages });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.map(state => state.eventRef?.authorParticipantId)).toEqual(['p-agent', 'p-agent', 'p-agent']);
    expect(await service.create({ operationId: 'op-agent', title: null })).toEqual({ kind: 'rejected', code: 'forbidden' });
  });

  it('does not retarget an outstanding batch to another author or device', async () => {
    const human = harness();
    const room = human.substrate.addRoom();
    human.substrate.sendMode = txn => (txn === 'txn-2' ? 'lose' : 'accept');
    await human.service.prepareIntro({ roomId: room.roomId, batchId: 'batch-5', messages });

    const asAgent = harness({ actor: agent, journal: human.journal, substrate: human.substrate });
    expect(await asAgent.service.resumeIntro('batch-5')).toEqual({ kind: 'rejected', code: 'forbidden' });

    human.device.view = { ...human.device.view, deviceId: 'device-2' as DeviceId, generation: 2 };
    expect(await human.service.resumeIntro('batch-5')).toEqual({ kind: 'rejected', code: 'forbidden' });
    expect(human.substrate.sendCalls.map(call => call.clientTxnId)).toEqual(['txn-1', 'txn-2']);
  });

  it('stops at a revoked membership and leaves accepted items accepted', async () => {
    const { service, substrate } = harness();
    const room = substrate.addRoom();
    substrate.sendMode = txn => (txn === 'txn-2' ? 'unavailable' : 'accept');
    await service.prepareIntro({ roomId: room.roomId, batchId: 'batch-6', messages });
    substrate.rooms.set(room.roomId, { ...room, membership: 'revoked' });
    substrate.sendMode = () => 'accept';
    expect(await service.resumeIntro('batch-6')).toEqual({ kind: 'rejected', code: 'forbidden' });
    expect(substrate.sendCalls).toHaveLength(2);

    substrate.rooms.set(room.roomId, { ...room, membership: 'joined' });
    expect(await service.resumeIntro('batch-6')).toMatchObject({ kind: 'ok', value: [{ state: 'accepted' }, { state: 'accepted' }, { state: 'accepted' }] });
    expect(substrate.landed).toHaveLength(3);
  });

  it('surfaces a transport rejection and keeps the item retryable', async () => {
    const { service, substrate } = harness();
    const room = substrate.addRoom();
    substrate.sendMode = (txn, attempt) => (txn === 'txn-1' && attempt === 0 ? { rejected: 'too_large' } : 'accept');
    expect(await service.prepareIntro({ roomId: room.roomId, batchId: 'batch-7', messages })).toEqual({ kind: 'rejected', code: 'too_large' });
    expect(await service.resumeIntro('batch-7')).toMatchObject({ kind: 'ok', value: [{ state: 'accepted' }, { state: 'accepted' }, { state: 'accepted' }] });
  });

  it('refuses a batch whose generated transaction IDs collide', async () => {
    const { service, substrate } = harness({ newId: () => 'same-txn' });
    const room = substrate.addRoom();
    expect(await service.prepareIntro({ roomId: room.roomId, batchId: 'batch-dup', messages })).toEqual({ kind: 'unavailable', retryable: true });
    expect(substrate.sendCalls).toEqual([]);
  });

  it('validates the batch before any effect', async () => {
    const { service, substrate } = harness();
    const room = substrate.addRoom();
    expect(await service.prepareIntro({ roomId: room.roomId, batchId: 'b', messages: [] })).toEqual({ kind: 'rejected', code: 'invalid_request' });
    expect(await service.prepareIntro({ roomId: room.roomId, batchId: 'b', messages: [text('x'.repeat(300))] })).toEqual({ kind: 'rejected', code: 'too_large' });
    expect(await service.prepareIntro({ roomId: 'missing' as never, batchId: 'b', messages })).toEqual({ kind: 'rejected', code: 'not_found' });
    expect(await service.resumeIntro('never-prepared')).toEqual({ kind: 'rejected', code: 'not_found' });
    expect(substrate.sendCalls).toEqual([]);
  });
});
