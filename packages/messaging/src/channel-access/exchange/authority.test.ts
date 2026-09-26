import { describe, expect, it } from 'vitest';
import { createGrantExchangeAuthority } from './authority';
import { CHANNEL_REF, DIGEST, T0, context, journalHarness, owner, requester } from './journal-harness.test';

const input = {
  operationId: 'op_access_1',
  requester: requester.principal,
  origin: requester.origin,
  sessionGeneration: 3,
  sessionFingerprint: DIGEST,
  claimOperationId: 'exchange_claim_1',
};

function setup() {
  const h = journalHarness();
  const authority = createGrantExchangeAuthority({ store: h.store, fulfillment: h.service.fulfillment, clock: h.clock });
  return { ...h, authority };
}

describe('hosted grant-exchange authority', () => {
  it('claims an approved access request once and rechecks idempotently', async () => {
    const h = setup();
    await h.approved();
    const first = await h.authority.authorize(input);
    expect(first).toMatchObject({
      kind: 'authorized',
      authorization: { kind: 'access', ownerId: owner.ownerId, channelRef: CHANNEL_REF, operationId: 'op_access_1' },
    });
    expect(await h.status()).toEqual({ v: 1, operationId: 'op_access_1', outcome: 'connecting' });
    expect(await h.authority.authorize(input)).toEqual(first);
    // A different consumer operation cannot take over the same claim.
    expect(await h.authority.authorize({ ...input, claimOperationId: 'exchange_claim_2' }))
      .toEqual({ kind: 'closed', reason: 'closed' });
  });

  it('never exposes an undecided, foreign, or cross-session request', async () => {
    const h = setup();
    await h.service.journal.requestAccess({
      v: 1, kind: 'listing_ref', operationId: 'op_access_1', credentialRef: 'credential_1', listingRef: 'listing_1',
    }, requester, context);
    expect(await h.authority.authorize(input)).toEqual({ kind: 'unavailable' });
    h.setNow(T0 + 5 * 60_000);
    await h.approved('op_access_2');
    for (const drift of [
      { sessionFingerprint: 'b'.repeat(43) },
      { sessionGeneration: 4 },
      { origin: 'https://other.example' },
      { requester: 'principal_2' as typeof requester.principal },
      { operationId: 'op_unknown' },
    ]) {
      expect(await h.authority.authorize({ ...input, operationId: 'op_access_2', ...drift })).toEqual({ kind: 'unavailable' });
    }
  });

  it('expires exactly at the persisted deadline and releases nothing after it', async () => {
    const h = setup();
    await h.approved();
    const located = await h.store.inspectRequester({
      requester: requester.principal, sessionFingerprint: DIGEST, sessionGeneration: 3, origin: requester.origin,
      kind: 'access', operationId: 'op_access_1',
    });
    if (located.kind !== 'found') throw new Error('missing');
    const deadline = Date.parse(located.context.deadline);
    h.setNow(deadline - 1);
    expect((await h.authority.authorize(input)).kind).toBe('authorized');
    h.setNow(deadline);
    expect(await h.authority.authorize(input)).toEqual({ kind: 'closed', reason: 'expired' });
  });

  it('expires an approved but unclaimed request at its deadline', async () => {
    const h = setup();
    await h.approved();
    h.setNow(T0 + 7 * 24 * 60 * 60_000);
    expect(await h.authority.authorize(input)).toEqual({ kind: 'closed', reason: 'expired' });
    expect(await h.status()).toEqual({ v: 1, operationId: 'op_access_1', outcome: 'expired' });
  });

  it('closes on owner loss, visibility loss, deletion, or requester revocation right before exchange', async () => {
    for (const change of ['owner', 'revision', 'deleted', 'requester'] as const) {
      const h = setup();
      await h.approved();
      if (change === 'owner') h.state.access = { kind: 'current', ownerId: 'owner_2' as never, targetRevision: 'target_revision_1', title: 'x' };
      if (change === 'revision') h.state.access = { kind: 'current', ownerId: owner.ownerId, targetRevision: 'target_revision_2', title: 'x' };
      if (change === 'deleted') h.state.access = { kind: 'revoked' };
      if (change === 'requester') h.state.requester = 'revoked';
      expect(await h.authority.authorize(input)).toEqual({ kind: 'closed', reason: 'closed' });
      expect((await h.status()).outcome).toBe('revoked');
    }
  });

  it('closes a claimed request as revoked without claiming readiness', async () => {
    const h = setup();
    await h.approved();
    const authorized = await h.authority.authorize(input);
    if (authorized.kind !== 'authorized') throw new Error('not authorized');
    expect(await h.authority.close({ authorization: authorized.authorization, operationId: 'close_1' })).toBe('closed');
    expect(await h.status()).toEqual({ v: 1, operationId: 'op_access_1', outcome: 'revoked' });
    expect(await h.authority.authorize(input)).toEqual({ kind: 'closed', reason: 'closed' });
  });

  it('marks a claimed request connected only on readiness, idempotently', async () => {
    const h = setup();
    await h.approved();
    await h.authority.authorize(input);
    expect(await h.status()).toEqual({ v: 1, operationId: 'op_access_1', outcome: 'connecting' });
    const ready = { ...input, readyOperationId: 'exchange_ready_1' };
    expect(await h.authority.markConnected(ready)).toBe('connected');
    expect(await h.status()).toEqual({ v: 1, operationId: 'op_access_1', outcome: 'connected' });
    // A lost acknowledgement response retried later reports the same result.
    expect(await h.authority.markConnected(ready)).toBe('connected');
  });

  it('never marks an undecided, closed, or foreign request connected', async () => {
    const h = setup();
    await h.service.journal.requestAccess({
      v: 1, kind: 'listing_ref', operationId: 'op_access_1', credentialRef: 'credential_1', listingRef: 'listing_1',
    }, requester, context);
    const ready = { ...input, readyOperationId: 'exchange_ready_1' };
    expect(await h.authority.markConnected(ready)).toBe('unavailable');
    expect((await h.status()).outcome).toBe('pending_owner');
    const revoked = setup();
    await revoked.approved();
    revoked.state.requester = 'revoked';
    expect(await revoked.authority.markConnected(ready)).toBe('closed');
    expect((await revoked.status()).outcome).toBe('revoked');
    expect(await revoked.authority.markConnected({ ...ready, sessionGeneration: 4 })).toBe('unavailable');
  });

  it('collapses journal failures to unavailable', async () => {
    const h = setup();
    await h.approved();
    h.backing.inject('read', 'throw');
    expect(await h.authority.authorize(input)).toEqual({ kind: 'unavailable' });
  });
});
