import { describe, expect, it } from 'vitest';
import type { OwnerId } from '@khala/contracts/messaging/index';
import { ensureMessagingAccount, mappingKey, readMessagingAccount } from './provisioning';
import { T0, fakeDirectory, fakeStore, secureRandom } from './support.test';

const owner = 'own_provisioning_test' as OwnerId;

function setup() {
  const store = fakeStore(() => T0);
  const messaging = fakeDirectory();
  const ensure = () => ensureMessagingAccount(store.store, messaging.directory, secureRandom, owner);
  return { store, messaging, ensure };
}

describe('ensureMessagingAccount', () => {
  it('creates one account keyed by the owner ID and activates the mapping', async () => {
    const { store, messaging, ensure } = setup();
    const result = await ensure();
    expect(result).toEqual({ kind: 'active', accountId: '@khala_1:messaging.test' });
    expect(messaging.accounts.get(owner)).toBe('@khala_1:messaging.test');
    expect(await readMessagingAccount(store.store, owner)).toEqual(result);
    expect(await ensure()).toEqual(result);
    expect(messaging.creates()).toBe(1);
  });

  it('adopts a remote account whose create response was lost, without a duplicate', async () => {
    const { store, messaging, ensure } = setup();
    messaging.inject('create', 'lose_create_response');
    expect(await ensure()).toEqual({ kind: 'unavailable' });
    expect(await readMessagingAccount(store.store, owner)).toEqual({ kind: 'pending' });
    expect(await ensure()).toEqual({ kind: 'active', accountId: '@khala_1:messaging.test' });
    expect(messaging.creates()).toBe(1);
  });

  it('converges competing requests for the same owner', async () => {
    const { messaging, ensure } = setup();
    const results = await Promise.all([ensure(), ensure(), ensure()]);
    const accounts = new Set(results.map(result => (result.kind === 'active' ? result.accountId : result.kind)));
    expect(accounts).toEqual(new Set(['@khala_1:messaging.test']));
    expect(messaging.accounts.size).toBe(1);
  });

  it('fails explicitly when a competing request activated a different account', async () => {
    const { store, messaging, ensure } = setup();
    messaging.accounts.set(owner, '@directory_account:messaging.test');
    const lookup = messaging.directory.lookup;
    // Between this request's lookup and its activation, another writer activates another account.
    messaging.directory.lookup = async externalId => {
      const found = await lookup(externalId);
      const pending = store.records.get(mappingKey(owner))!;
      store.records.set(mappingKey(owner), {
        ...pending, revision: 'r-other', value: { v: 1, ownerId: owner, state: 'active', accountId: '@other_account:messaging.test' },
      });
      return found;
    };
    expect(await ensure()).toEqual({ kind: 'conflict' });
  });

  it('leaves a retryable pending mapping during a messaging outage', async () => {
    const { store, messaging, ensure } = setup();
    messaging.inject('lookup', 'unavailable');
    expect(await ensure()).toEqual({ kind: 'unavailable' });
    messaging.inject('create', 'throw');
    expect(await ensure()).toEqual({ kind: 'unavailable' });
    expect(await readMessagingAccount(store.store, owner)).toEqual({ kind: 'pending' });
    expect((await ensure()).kind).toBe('active');
  });

  it('reports a store outage as unavailable without touching the directory', async () => {
    const { store, messaging, ensure } = setup();
    store.inject('read', 'unavailable');
    expect(await ensure()).toEqual({ kind: 'unavailable' });
    expect(messaging.creates()).toBe(0);
  });

  it('stores only the protocol account ID in the mapping', async () => {
    const { store, ensure } = setup();
    await ensure();
    const value = store.records.get(mappingKey(owner))!.value;
    expect(value).toEqual({ v: 1, ownerId: owner, state: 'active', accountId: '@khala_1:messaging.test' });
  });
});
