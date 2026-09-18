import { describe, expect, it } from 'vitest';
import type { OwnerId, ParticipantId } from '@khala/contracts/messaging/index';
import { CREATE_LEASE_MS } from './create';
import { agent, deviceId, harness, human, principal } from './fixtures/fakes';

describe('room create', () => {
  it('returns the summary for a named room and for an unnamed room', async () => {
    const { service } = harness();
    const named = await service.create({ operationId: 'op-named', title: 'Planning' });
    const unnamed = await service.create({ operationId: 'op-unnamed', title: null });
    const blank = await service.create({ operationId: 'op-blank', title: '' });
    expect(named).toMatchObject({ kind: 'ok', value: { title: 'Planning', membership: 'joined' } });
    expect(unnamed).toMatchObject({ kind: 'ok', value: { title: null } });
    // An empty title is not a title.
    expect(blank).toMatchObject({ kind: 'ok', value: { title: null } });
  });

  it('returns the same room when an already-created operation is repeated', async () => {
    const { service, substrate } = harness();
    const first = await service.create({ operationId: 'op-1', title: 'Chat' });
    const again = await service.create({ operationId: 'op-1', title: 'Chat' });
    expect(again).toEqual(first);
    expect(substrate.createCalls).toEqual(['op-1']);
  });

  it('keeps a lost create response unknown and reconciles it without a second room', async () => {
    const { service, substrate } = harness();
    substrate.createMode = 'lose';
    expect(await service.create({ operationId: 'op-lost', title: 'Chat' })).toEqual({ kind: 'outcome_unknown', operationId: 'op-lost' });

    substrate.createMode = 'accept';
    const retried = await service.create({ operationId: 'op-lost', title: 'Chat' });
    expect(retried).toEqual({ kind: 'ok', value: substrate.byOperation.get('op-lost') });
    expect(substrate.createCalls).toEqual(['op-lost']);
    expect(substrate.rooms.size).toBe(1);
  });

  it('treats a thrown SDK create as unknown, never as a failure', async () => {
    const { service, substrate } = harness();
    substrate.createMode = 'throw';
    expect(await service.create({ operationId: 'op-throw', title: null })).toEqual({ kind: 'outcome_unknown', operationId: 'op-throw' });
    substrate.createMode = 'accept';
    expect(await service.create({ operationId: 'op-throw', title: null })).toMatchObject({ kind: 'ok' });
    expect(substrate.rooms.size).toBe(1);
  });

  it('stays unknown while the substrate cannot prove whether the room exists', async () => {
    const { service, substrate } = harness();
    substrate.createMode = 'lose';
    await service.create({ operationId: 'op-u', title: null });
    substrate.createMode = 'accept';
    substrate.lookupMode = 'unknown';
    expect(await service.create({ operationId: 'op-u', title: null })).toEqual({ kind: 'outcome_unknown', operationId: 'op-u' });
    substrate.lookupMode = 'unavailable';
    expect(await service.create({ operationId: 'op-u', title: null })).toEqual({ kind: 'outcome_unknown', operationId: 'op-u' });
    expect(substrate.createCalls).toEqual(['op-u']);
  });

  it('creates again only after proof that the first attempt created nothing', async () => {
    const { service, substrate } = harness();
    substrate.createMode = 'lose';
    await service.create({ operationId: 'op-p', title: null });
    substrate.byOperation.clear();
    substrate.rooms.clear();
    substrate.createMode = 'accept';
    expect(await service.create({ operationId: 'op-p', title: null })).toMatchObject({ kind: 'ok' });
    expect(substrate.createCalls).toEqual(['op-p', 'op-p']);
  });

  it('retries an unavailable create with the same operation', async () => {
    const { service, substrate } = harness();
    substrate.createMode = 'unavailable';
    expect(await service.create({ operationId: 'op-a', title: null })).toEqual({ kind: 'unavailable', retryable: true });
    substrate.createMode = 'accept';
    expect(await service.create({ operationId: 'op-a', title: null })).toMatchObject({ kind: 'ok' });
    expect(substrate.createCalls).toEqual(['op-a', 'op-a']);
  });

  it('lets only one of two overlapping creates reach the SDK', async () => {
    const { service, substrate } = harness();
    let release = () => {};
    substrate.createGate = new Promise(resolve => { release = resolve; });
    const first = service.create({ operationId: 'op-race', title: null });
    const second = await service.create({ operationId: 'op-race', title: null });
    expect(second).toEqual({ kind: 'outcome_unknown', operationId: 'op-race' });
    release();
    const settled = await first;
    expect(settled).toMatchObject({ kind: 'ok' });
    expect(await service.create({ operationId: 'op-race', title: null })).toEqual(settled);
    expect(substrate.createCalls).toEqual(['op-race']);
  });

  it('reconciles an attempt whose lease expired without a result', async () => {
    const { service, substrate, time } = harness();
    substrate.createGate = new Promise(() => {});
    void service.create({ operationId: 'op-stale', title: null });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(await service.create({ operationId: 'op-stale', title: null })).toEqual({ kind: 'outcome_unknown', operationId: 'op-stale' });

    time.now += CREATE_LEASE_MS;
    substrate.createGate = null;
    expect(await service.create({ operationId: 'op-stale', title: null })).toMatchObject({ kind: 'ok' });
    expect(substrate.createCalls).toEqual(['op-stale', 'op-stale']);
    expect(substrate.rooms.size).toBe(1);
  });

  it('rejects the same operation ID with another title or another owner', async () => {
    const first = harness();
    await first.service.create({ operationId: 'op-m', title: 'One' });
    expect(await first.service.create({ operationId: 'op-m', title: 'Two' })).toEqual({ kind: 'rejected', code: 'operation_mismatch' });

    const otherOwner = 'owner-2' as OwnerId;
    const other = harness({
      journal: first.journal,
      substrate: first.substrate,
      principal: { ...principal, ownerId: otherOwner, providerSubject: 'subject-2' },
      actor: { ...human, participantId: 'p-other' as ParticipantId, ownerId: otherOwner },
    });
    expect(await other.service.create({ operationId: 'op-m', title: 'One' })).toEqual({ kind: 'rejected', code: 'operation_mismatch' });
    expect(first.substrate.createCalls).toEqual(['op-m']);
  });

  it('refuses room creation to a delegated agent', async () => {
    const { service, substrate } = harness({ actor: agent });
    expect(await service.create({ operationId: 'op-agent', title: null })).toEqual({ kind: 'rejected', code: 'forbidden' });
    expect(substrate.createCalls).toEqual([]);
  });

  it('validates titles against the substrate limits', async () => {
    const { service, substrate } = harness();
    expect(await service.create({ operationId: 'op-long', title: 'x'.repeat(33) })).toEqual({ kind: 'rejected', code: 'too_large' });
    expect(await service.create({ operationId: 'op-bidi', title: 'a\u202eb' })).toEqual({ kind: 'rejected', code: 'invalid_request' });
    expect(await service.create({ operationId: '', title: null })).toEqual({ kind: 'rejected', code: 'invalid_request' });
    expect(substrate.createCalls).toEqual([]);
  });

  it('does nothing until the device is ready', async () => {
    const { service, substrate, device } = harness();
    device.view = { deviceId: null, state: 'initializing', generation: 1, reason: null };
    expect(await service.create({ operationId: 'op-d', title: null })).toEqual({ kind: 'unavailable', retryable: true });
    device.view = { deviceId, state: 'revoked', generation: 2, reason: 'revoked_by_owner' };
    expect(await service.create({ operationId: 'op-d', title: null })).toEqual({ kind: 'rejected', code: 'forbidden' });
    expect(substrate.createCalls).toEqual([]);
  });
});
