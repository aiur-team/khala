import { describe, expect, it } from 'vitest';
import {
  CHANNEL_ACCESS_COOLDOWN_MS,
  CHANNEL_ACCESS_DEADLINE_MS,
  CHANNEL_ACCESS_PURGE_MS,
  createChannelAccessPolicy,
} from './policy';
import {
  createChannelAccessStore,
  type ChannelAccessCreateInput,
} from './store';
import { fakeControlStore } from './support.test';

const T0 = Date.parse('2026-09-24T12:00:00Z');
const key = new Uint8Array(32).fill(7);

function barrier(parties: number) {
  let arrivals = 0;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  return async () => {
    arrivals += 1;
    if (arrivals === parties) release();
    await ready;
  };
}

function request(overrides: Partial<ChannelAccessCreateInput> = {}): ChannelAccessCreateInput {
  return {
    requester: 'principal_1',
    sessionFingerprint: 'session_1',
    sessionGeneration: 3,
    origin: 'https://khala.example',
    operationId: 'request_1',
    ownerId: 'owner_1',
    targetFingerprint: 'target_1',
    detail: { kind: 'access', authorizedChannelRef: 'authorized_1', targetRevision: 'target_revision_1', title: 'Private channel' },
    harness: 'codex',
    requesterLabel: 'Build agent',
    workspaceLabel: 'Khala',
    ...overrides,
  };
}

function harness(options: Readonly<{ requesterMax?: number; ownerMax?: number }> = {}) {
  let now = T0;
  const backing = fakeControlStore();
  const policy = createChannelAccessPolicy({ key, ...options });
  const journal = createChannelAccessStore({ store: backing.store, policy, clock: () => now });
  return { ...backing, journal, policy, setNow(value: number) { now = value; } };
}

async function accepted(h: ReturnType<typeof harness>, input = request()) {
  const result = await h.journal.create(input);
  if (result.kind !== 'accepted') throw new Error(`request failed: ${result.kind}`);
  return result;
}

describe('channel access journal creation', () => {
  it('reconciles exact retries, rejects changed bindings, and settles a lost response', async () => {
    const h = harness();
    h.inject('compareAndSet', 'lose_response');
    const first = await accepted(h);
    expect(await h.journal.create(request())).toEqual(first);
    expect(await h.journal.create(request({ origin: 'https://other.example' }))).toEqual({ kind: 'unavailable' });
    expect([...h.records]).toHaveLength(1);
  });

  it('atomically enforces requester and owner caps, including a synchronized last-slot race', async () => {
    const h = harness({ requesterMax: 2, ownerMax: 2 });
    await accepted(h, request({ operationId: 'first', targetFingerprint: 'target_a' }));
    h.setNow(T0 + CHANNEL_ACCESS_COOLDOWN_MS);
    const rendezvous = barrier(2);
    h.interceptWrites(async input => {
      const value = input.next.value as { requests?: Record<string, unknown> };
      if (Object.keys(value.requests ?? {}).length === 2) await rendezvous();
    });
    const results = await Promise.all([
      h.journal.create(request({ operationId: 'second_a', targetFingerprint: 'target_b' })),
      h.journal.create(request({ operationId: 'second_b', targetFingerprint: 'target_c' })),
    ]);
    expect(results.filter(result => result.kind === 'accepted')).toHaveLength(1);
    expect(results.filter(result => result.kind === 'unavailable')).toHaveLength(1);

    const owner = harness({ requesterMax: 5, ownerMax: 1 });
    await accepted(owner);
    expect(await owner.journal.create(request({ requester: 'principal_2', operationId: 'other', targetFingerprint: 'other' })))
      .toEqual({ kind: 'unavailable' });
  });

  it('pins the default fifth/sixth requester and 50th/51st owner boundaries', async () => {
    const requester = harness();
    for (let index = 0; index < 5; index += 1) {
      expect((await requester.journal.create(request({ operationId: `requester_${index}`, targetFingerprint: `target_${index}` }))).kind)
        .toBe('accepted');
    }
    expect(await requester.journal.create(request({ operationId: 'requester_6', targetFingerprint: 'target_6' })))
      .toEqual({ kind: 'unavailable' });

    const owner = harness();
    for (let index = 0; index < 50; index += 1) {
      expect((await owner.journal.create(request({ requester: `owner_requester_${index}`, operationId: `owner_${index}`, targetFingerprint: `owner_target_${index}` }))).kind)
        .toBe('accepted');
    }
    expect(await owner.journal.create(request({ requester: 'owner_requester_51', operationId: 'owner_51', targetFingerprint: 'owner_target_51' })))
      .toEqual({ kind: 'unavailable' });
  });

  it('enforces cooldown and operation-specific indefinite mutes without creating rows', async () => {
    const h = harness();
    await accepted(h);
    expect(await h.journal.create(request({ operationId: 'cooldown' }))).toEqual({ kind: 'unavailable' });
    expect(await h.journal.setMute({
      ownerId: 'owner_1', requester: 'principal_2', kind: 'create', targetFingerprint: 'proposal_a',
      action: 'mute', expectedRevision: null, operationId: 'mute_1',
    })).toMatchObject({ kind: 'updated', enabled: true, revision: 1 });
    expect(await h.journal.create(request({
      requester: 'principal_2', operationId: 'create_muted', targetFingerprint: 'proposal_b',
      detail: { kind: 'create', proposalDigest: 'proposal_b', proposedTitle: 'Private channel', ownerRevision: 'owner_revision_1' },
    }))).toEqual({ kind: 'unavailable' });
  });
});

describe('channel access journal reads and decisions', () => {
  it('binds requester inspection and owner reads, then requires the displayed revision', async () => {
    const h = harness();
    const created = await accepted(h);
    expect(await h.journal.inspect(request())).toMatchObject({ kind: 'found', status: { outcome: 'pending_owner' } });
    expect(await h.journal.inspect(request({ sessionGeneration: 4 }))).toEqual({ kind: 'unavailable' });
    expect(await h.journal.inspectRequester({
      requester: 'principal_1', sessionFingerprint: 'session_1', sessionGeneration: 3,
      origin: 'https://khala.example', kind: 'access', operationId: 'request_1',
    })).toMatchObject({ kind: 'found', status: { outcome: 'pending_owner' } });
    expect(await h.journal.inspectRequester({
      requester: 'principal_1', sessionFingerprint: 'session_1', sessionGeneration: 4,
      origin: 'https://khala.example', kind: 'access', operationId: 'request_1',
    })).toEqual({ kind: 'unavailable' });
    expect(await h.journal.readOwner({ ownerId: 'owner_2', requestHandle: created.requestHandle })).toEqual({ kind: 'not_found' });
    const inbox = await h.journal.listOwner({ ownerId: 'owner_1' });
    expect(inbox).toMatchObject({ kind: 'found', requests: [{ requestHandle: created.requestHandle, revision: 1 }] });
    expect(await h.journal.decide({
      ownerId: 'owner_1', requestHandle: created.requestHandle, expectedRevision: 2,
      decision: 'approve', operationId: 'decision_stale',
    })).toEqual({ kind: 'stale' });
    const decision = await h.journal.decide({
      ownerId: 'owner_1', requestHandle: created.requestHandle, expectedRevision: 1,
      decision: 'approve', operationId: 'decision_1',
    });
    expect(decision).toMatchObject({ kind: 'decided', outcome: 'approved', revision: 2 });
    expect(await h.journal.decide({
      ownerId: 'owner_1', requestHandle: created.requestHandle, expectedRevision: 1,
      decision: 'approve', operationId: 'decision_1',
    })).toEqual(decision);
    expect(await h.journal.decide({
      ownerId: 'owner_1', requestHandle: created.requestHandle, expectedRevision: 1,
      decision: 'deny', operationId: 'decision_1',
    })).toEqual({ kind: 'conflict' });
  });

  it('expires at the persisted boundary before a decision or claim', async () => {
    const h = harness();
    const created = await accepted(h);
    h.setNow(T0 + CHANNEL_ACCESS_DEADLINE_MS);
    expect(await h.journal.decide({
      ownerId: 'owner_1', requestHandle: created.requestHandle, expectedRevision: 1,
      decision: 'approve', operationId: 'too_late',
    })).toEqual({ kind: 'expired' });
    expect(await h.journal.inspect(request())).toMatchObject({ kind: 'found', status: { outcome: 'expired' } });
  });

  it('expires an approved but unclaimed request at the deadline, freeing its slot and refusing the claim', async () => {
    const h = harness({ requesterMax: 1 });
    const created = await accepted(h);
    expect(await h.journal.decide({
      ownerId: 'owner_1', requestHandle: created.requestHandle, expectedRevision: 1,
      decision: 'approve', operationId: 'approve',
    })).toMatchObject({ kind: 'decided', outcome: 'approved', revision: 2 });
    const next = request({ operationId: 'next', targetFingerprint: 'target_2' });
    h.setNow(T0 + CHANNEL_ACCESS_COOLDOWN_MS);
    expect(await h.journal.create(next)).toEqual({ kind: 'unavailable' });

    h.setNow(T0 + CHANNEL_ACCESS_DEADLINE_MS);
    expect(await h.journal.inspect(request())).toMatchObject({ kind: 'found', status: { outcome: 'expired', revision: 3 } });
    expect(await h.journal.claimAccess({
      binding: request(), expectedRevision: 2, consumerId: 'grant_exchange', operationId: 'late_claim',
    })).toEqual({ kind: 'expired' });
    expect(await h.journal.claimAccess({
      binding: request(), expectedRevision: 3, consumerId: 'grant_exchange', operationId: 'late_claim_current',
    })).toEqual({ kind: 'expired' });
    expect((await h.journal.create(next)).kind).toBe('accepted');
  });
});

describe('channel access fulfillment and retention', () => {
  it('returns operation-specific authorization only after a typed claim and records lifecycle', async () => {
    const access = harness();
    const accessCreated = await accepted(access);
    await access.journal.decide({ ownerId: 'owner_1', requestHandle: accessCreated.requestHandle, expectedRevision: 1, decision: 'approve', operationId: 'approve' });
    const claimedAccess = await access.journal.claimAccess({
      binding: request(), expectedRevision: 2, consumerId: 'grant_exchange', operationId: 'claim_access',
    });
    expect(claimedAccess).toMatchObject({
      kind: 'claimed', authorization: { kind: 'access', authorizedChannelRef: 'authorized_1' }, revision: 3,
    });
    expect(await access.journal.updateLifecycle({
      requestHandle: accessCreated.requestHandle, expectedRevision: 3, consumerId: 'grant_exchange',
      outcome: 'connected', operationId: 'connected',
    })).toMatchObject({ kind: 'updated', outcome: 'connected', revision: 4 });

    const create = harness();
    const createInput = request({
      detail: { kind: 'create', proposalDigest: 'proposal_1', proposedTitle: 'New channel', ownerRevision: 'owner_revision_1' },
    });
    const createCreated = await accepted(create, createInput);
    await create.journal.decide({ ownerId: 'owner_1', requestHandle: createCreated.requestHandle, expectedRevision: 1, decision: 'approve', operationId: 'approve_create' });
    expect(await create.journal.claimAccess({
      binding: createInput, expectedRevision: 2, consumerId: 'grant_exchange', operationId: 'wrong_kind',
    })).toEqual({ kind: 'unavailable' });
    expect(await create.journal.claimCreate({
      binding: createInput, expectedRevision: 2, consumerId: 'create_workflow', operationId: 'claim_create',
    })).toMatchObject({ kind: 'claimed', authorization: { kind: 'create', proposedTitle: 'New channel' } });
  });

  it('keeps nine individual notifications plus one revisioned batch and acknowledges exact revisions', async () => {
    const h = harness({ requesterMax: 5, ownerMax: 50 });
    for (let index = 0; index < 12; index += 1) {
      await accepted(h, request({ requester: `principal_${index}`, operationId: `op_${index}`, targetFingerprint: `target_${index}` }));
    }
    const listed = await h.journal.listNotifications({ ownerId: 'owner_1' });
    expect(listed.kind).toBe('found');
    if (listed.kind !== 'found') throw new Error('notification read failed');
    expect(listed.notifications).toHaveLength(10);
    const batch = listed.notifications.find(item => item.kind === 'batch');
    expect(batch).toMatchObject({ revision: 3, count: 3 });
    if (!batch) throw new Error('batch missing');
    expect(await h.journal.ackNotification({ ownerId: 'owner_1', notificationId: batch.id, revision: 2, operationId: 'ack_stale' }))
      .toEqual({ kind: 'stale' });
    expect(await h.journal.ackNotification({ ownerId: 'owner_1', notificationId: batch.id, revision: 3, operationId: 'ack_batch' }))
      .toEqual({ kind: 'acknowledged' });
  });

  it('suppresses undelivered notifications when a request reaches a terminal state', async () => {
    const h = harness({ requesterMax: 5, ownerMax: 50 });
    const handles: string[] = [];
    for (let index = 0; index < 11; index += 1) {
      const created = await accepted(h, request({ requester: `principal_${index}`, operationId: `op_${index}`, targetFingerprint: `target_${index}` }));
      handles.push(created.requestHandle);
    }
    await h.journal.decide({ ownerId: 'owner_1', requestHandle: handles[0]!, expectedRevision: 1, decision: 'deny', operationId: 'deny_0' });
    await h.journal.decide({ ownerId: 'owner_1', requestHandle: handles[10]!, expectedRevision: 1, decision: 'deny', operationId: 'deny_10' });
    const listed = await h.journal.listNotifications({ ownerId: 'owner_1' });
    if (listed.kind !== 'found') throw new Error('notification read failed');
    expect(listed.notifications.filter(item => item.kind === 'request')).toHaveLength(8);
    expect(listed.notifications.find(item => item.kind === 'batch')).toMatchObject({ count: 1, revision: 3 });

    h.setNow(T0 + CHANNEL_ACCESS_DEADLINE_MS);
    expect(await h.journal.listNotifications({ ownerId: 'owner_1' })).toEqual({ kind: 'found', notifications: [] });
  });

  it('compacts terminal sensitive rows to an outcome-only operation tombstone after 30 days', async () => {
    const h = harness();
    const created = await accepted(h);
    await h.journal.decide({ ownerId: 'owner_1', requestHandle: created.requestHandle, expectedRevision: 1, decision: 'deny', operationId: 'deny' });
    h.setNow(T0 + CHANNEL_ACCESS_PURGE_MS);
    expect(await h.journal.inspect(request())).toEqual({ kind: 'unavailable' });
    const serialized = JSON.stringify([...h.records.values()][0]?.value);
    expect(serialized).not.toContain('principal_1');
    expect(serialized).not.toContain('session_1');
    expect(serialized).not.toContain('https://khala.example');
    expect(serialized).not.toContain('owner_1');
    expect(serialized).not.toContain('target_1');
    expect(serialized).not.toContain('Build agent');
    const aggregate = [...h.records.values()][0]?.value as { requests: object; tombstones: Record<string, unknown> };
    expect(Object.keys(aggregate.requests)).toHaveLength(0);
    expect(Object.values(aggregate.tombstones)).toEqual([{ outcome: 'denied' }]);
    expect(await h.journal.create(request())).toEqual({ kind: 'unavailable' });
  });
});
