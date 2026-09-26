import type { AuthorizedChannelRef, HumanAuthorizedWorkflowContext, OwnerId } from '@khala/contracts/messaging/index';
import { describe, expect, it } from 'vitest';
import { createSubstrateChannelCreateAdapter } from './adapter';
import { T0, fakeSubstrate } from './support.test';

const KEY = `chcreate_${'k'.repeat(43)}`;
const workflow: HumanAuthorizedWorkflowContext = {
  v: 1,
  kind: 'human_authorized_channel_create',
  ownerId: 'owner_1' as OwnerId,
  authorizationRef: 'authorization_1',
  expiresAt: new Date(T0 + 60_000).toISOString(),
};
const intent = { v: 1 as const, operationId: 'op_1', credentialRef: 'authorization_1', origin: 'https://khala.example', proposedTitle: 'Notes' };

function adapter(proves: 'absent' | 'unknown', now = T0) {
  const fake = fakeSubstrate(proves);
  return {
    fake,
    port: createSubstrateChannelCreateAdapter({
      substrate: fake.substrate,
      channelRef: roomId => `ref_${roomId.slice(1)}` as AuthorizedChannelRef,
      clock: () => now,
    }),
  };
}

describe('substrate channel create adapter', () => {
  it('creates under the idempotency key and never returns the room ID', async () => {
    const { fake, port } = adapter('absent');
    const created = await port.create({ intent, workflow, idempotencyKey: KEY });

    expect(created).toEqual({ v: 1, idempotencyKey: KEY, outcome: 'created', channelRef: 'ref_room_1' });
    expect(fake.createCalls).toEqual([{ operationId: KEY, title: 'Notes' }]);
    expect(await port.reconcile({ workflow, idempotencyKey: KEY }))
      .toEqual({ v: 1, idempotencyKey: KEY, outcome: 'already_created', channelRef: 'ref_room_1' });
  });

  it('maps substrate outcomes without guessing', async () => {
    const internal = adapter('absent');
    expect((await internal.port.reconcile({ workflow, idempotencyKey: KEY })).outcome).toBe('pending');
    internal.fake.fail('lose_response', 'unavailable', 'rejected');
    expect((await internal.port.create({ intent, workflow, idempotencyKey: KEY })).outcome).toBe('outcome_unknown');
    expect((await internal.port.create({ intent, workflow, idempotencyKey: KEY })).outcome).toBe('unavailable');
    expect((await internal.port.create({ intent, workflow, idempotencyKey: KEY })).outcome).toBe('denied');

    // The hosted substrate cannot prove absence, so a lookup miss stays unknown.
    const hosted = adapter('unknown');
    expect(await hosted.port.reconcile({ workflow, idempotencyKey: KEY }))
      .toEqual({ v: 1, idempotencyKey: KEY, outcome: 'outcome_unknown', channelRef: null });
  });

  it('treats a thrown create as possibly applied', async () => {
    const { fake } = adapter('absent');
    const port = createSubstrateChannelCreateAdapter({
      substrate: { ...fake.substrate, createRoom: async () => { throw new Error('sdk detail'); } },
      channelRef: roomId => roomId as unknown as AuthorizedChannelRef,
      clock: () => T0,
    });

    expect((await port.create({ intent, workflow, idempotencyKey: KEY })).outcome).toBe('outcome_unknown');
  });

  it('refuses to create for an expired or foreign workflow context', async () => {
    const expired = adapter('absent', T0 + 60_000);
    expect((await expired.port.create({ intent, workflow, idempotencyKey: KEY })).outcome).toBe('unavailable');
    const foreign = adapter('absent');
    const forged = { ...workflow, kind: 'agent_request' } as unknown as HumanAuthorizedWorkflowContext;
    expect((await foreign.port.create({ intent, workflow: forged, idempotencyKey: KEY })).outcome).toBe('unavailable');
    expect([...expired.fake.createCalls, ...foreign.fake.createCalls]).toEqual([]);
  });
});
