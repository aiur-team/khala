import { describe, expect, it } from 'vitest';
import { fakeControlStore } from '../journal/support.test';
import { createExchangeGrantIssuer, type ExchangeGrantBinding } from './grants';
import { CHANNEL_REF, DEVICE, T0, owner, requester } from './journal-harness.test';

const binding: ExchangeGrantBinding = {
  operationId: 'op_access_1',
  requester: requester.principal,
  origin: requester.origin,
  sessionGeneration: 3,
  deviceId: DEVICE,
  proofKeyThumbprint: 'p'.repeat(43),
  ownerId: owner.ownerId,
  channelRef: CHANNEL_REF,
};
const EXPIRES = new Date(T0 + 15 * 60_000).toISOString();

function redemption(grant: string, overrides: Partial<Parameters<ReturnType<typeof createExchangeGrantIssuer>['redeem']>[0]> = {}) {
  return {
    grant,
    operationId: binding.operationId,
    requester: binding.requester,
    origin: binding.origin,
    sessionGeneration: binding.sessionGeneration,
    deviceId: binding.deviceId,
    proofKeyThumbprint: binding.proofKeyThumbprint,
    ...overrides,
  };
}

function setup() {
  let now = T0;
  const backing = fakeControlStore();
  const issuer = createExchangeGrantIssuer({ store: backing.store, clock: () => now });
  return { backing, issuer, setNow(value: number) { now = value; } };
}

async function mint(issuer: ReturnType<typeof setup>['issuer']): Promise<string> {
  const minted = await issuer.mint({ binding, expiresAt: EXPIRES });
  if (minted.kind !== 'minted') throw new Error('mint failed');
  return minted.grant;
}

describe('hosted exchange grant issuer', () => {
  it('mints a 256-bit grant and stores only its hash', async () => {
    const h = setup();
    const grant = await mint(h.issuer);
    expect(grant).toMatch(/^cagrant_[A-Za-z0-9_-]{43}$/);
    const persisted = JSON.stringify([...h.backing.records.values()]);
    expect(persisted).not.toContain(grant);
    expect(persisted).not.toContain(grant.slice('cagrant_'.length));
    expect([...h.backing.records.values()][0]!.expiresAt).toBe(EXPIRES);
  });

  it('redeems once for the bound tuple and treats every later presentation as a replay', async () => {
    const h = setup();
    const grant = await mint(h.issuer);
    expect(await h.issuer.redeem(redemption(grant))).toEqual({ kind: 'redeemed', binding });
    expect(await h.issuer.redeem(redemption(grant))).toEqual({ kind: 'rejected', code: 'grant_replayed' });
  });

  it('refuses a grant presented by another requester, origin, session, device, proof key, or operation', async () => {
    const h = setup();
    const grant = await mint(h.issuer);
    for (const drift of [
      { requester: 'principal_2' as typeof binding.requester },
      { origin: 'https://other.example' },
      { sessionGeneration: 4 },
      { deviceId: 'device_agent_2' as typeof DEVICE },
      { proofKeyThumbprint: 'q'.repeat(43) },
      { operationId: 'op_access_2' },
    ]) {
      expect(await h.issuer.redeem(redemption(grant, drift))).toEqual({ kind: 'rejected', code: 'invalid_grant' });
    }
    expect(await h.issuer.redeem(redemption('cagrant_forged'))).toEqual({ kind: 'rejected', code: 'invalid_grant' });
    expect(await h.issuer.redeem(redemption(`cagrant_${'A'.repeat(43)}`))).toEqual({ kind: 'rejected', code: 'invalid_grant' });
    expect(await h.issuer.redeem(redemption(grant))).toEqual({ kind: 'redeemed', binding });
  });

  it('is short-lived', async () => {
    const h = setup();
    const grant = await mint(h.issuer);
    h.setNow(Date.parse(EXPIRES));
    const late = await h.issuer.redeem(redemption(grant));
    // The store drops the record at expiry; either way it is never redeemable.
    expect(late.kind).toBe('rejected');
    expect(await h.issuer.mint({ binding, expiresAt: EXPIRES })).toEqual({ kind: 'unavailable' });
  });

  it('lets at most one grant per operation be redeemed, even after a remint', async () => {
    const h = setup();
    const orphan = await mint(h.issuer);
    const sealed = await mint(h.issuer);
    expect(await h.issuer.redeem(redemption(sealed))).toEqual({ kind: 'redeemed', binding });
    expect(await h.issuer.redeem(redemption(orphan))).toEqual({ kind: 'rejected', code: 'grant_replayed' });
  });

  it('reports the tuple a grant already redeemed without consuming anything', async () => {
    const h = setup();
    const orphan = await mint(h.issuer);
    const sealed = await mint(h.issuer);
    expect(await h.issuer.consumed(redemption(sealed))).toEqual({ kind: 'rejected', code: 'not_consumed' });
    expect(await h.issuer.redeem(redemption(sealed))).toEqual({ kind: 'redeemed', binding });
    const records = h.backing.records.size;
    expect(await h.issuer.consumed(redemption(sealed))).toEqual({ kind: 'consumed', binding });
    expect(h.backing.records.size).toBe(records);
    // Another grant for the same operation, or a drifted tuple, never learns the binding.
    expect(await h.issuer.consumed(redemption(orphan))).toEqual({ kind: 'rejected', code: 'not_consumed' });
    expect(await h.issuer.consumed(redemption(sealed, { deviceId: 'device_agent_2' as typeof DEVICE })))
      .toEqual({ kind: 'rejected', code: 'invalid_grant' });
  });

  it('reports store failures as unavailable, never as a grant', async () => {
    const h = setup();
    h.backing.inject('compareAndSet', 'unavailable');
    expect(await h.issuer.mint({ binding, expiresAt: EXPIRES })).toEqual({ kind: 'unavailable' });
    const grant = await mint(h.issuer);
    h.backing.inject('read', 'throw');
    expect(await h.issuer.redeem(redemption(grant))).toEqual({ kind: 'unavailable' });
    h.backing.inject('compareAndSet', 'lose_response');
    expect(await h.issuer.redeem(redemption(grant))).toEqual({ kind: 'redeemed', binding });
  });
});
