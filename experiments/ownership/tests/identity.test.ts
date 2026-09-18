// Owner identity against a real disposable OIDC provider; account storage is an
// in-memory double here (live Synapse reconciliation is in journey.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from '../src/browser.ts';
import { MemoryAccounts, ensureAccount, localpartFor } from '../src/provisioning.ts';
import { fakeDeviceLogin, me, signIn, startStack } from './support.ts';

const alice = { sub: 'alice-subject', email: 'alice@old.test', password: 'disposable-a' };

test('same issuer/subject keeps one owner and one messaging account through an email change', async () => {
  const accounts = new MemoryAccounts();
  const stack = await startStack([alice], { accounts, deviceLogin: fakeDeviceLogin });
  try {
    const first = await signIn(new Browser(), stack, alice.email, alice.password);
    assert.equal(first.email, 'alice@old.test');
    stack.idp.setEmail(alice.sub, 'alice@new.test');
    const second = await signIn(new Browser(), stack, 'alice@new.test', alice.password);
    assert.equal(second.ownerId, first.ownerId);
    assert.equal(second.email, 'alice@new.test');
    assert.equal(second.messagingUserId, first.messagingUserId);
    assert.equal(stack.control.owners.size, 1);
    assert.equal(accounts.accounts.size, 1);
  } finally {
    await stack.close();
  }
});

test('wrong provider credentials never produce a Khala session', async () => {
  const stack = await startStack([alice], { accounts: new MemoryAccounts(), deviceLogin: fakeDeviceLogin });
  try {
    const browser = new Browser();
    const form = await browser.navigate(`${stack.control.origin}/api/human/auth/login`);
    await browser.navigate(form.url.href, { method: 'POST', form: { email: alice.email, password: 'wrong' } });
    const response = await browser.appRequest(`${stack.control.origin}/api/human/me`, 'GET', undefined);
    assert.equal(response.status, 401);
  } finally {
    await stack.close();
  }
});

test('a lost provisioning response reconciles to exactly one account', async () => {
  const accounts = new MemoryAccounts();
  accounts.loseNextCreateResponse = true;
  const userId = await ensureAccount(accounts, 'own_example', 'human', 'Alice');
  assert.equal(userId, `@${localpartFor('own_example', 'human')}:khala-test.invalid`);
  assert.equal(await ensureAccount(accounts, 'own_example', 'human', 'Alice'), userId);
  assert.equal(accounts.accounts.size, 1);
});

test('the sign-in path survives a lost provisioning response', async () => {
  const accounts = new MemoryAccounts();
  accounts.loseNextCreateResponse = true;
  const stack = await startStack([alice], { accounts, deviceLogin: fakeDeviceLogin });
  try {
    const view = await signIn(new Browser(), stack, alice.email, alice.password);
    assert.ok(view.messagingUserId);
    assert.equal(accounts.accounts.size, 1);
  } finally {
    await stack.close();
  }
});

test('the browser projection carries identifiers only', async () => {
  const stack = await startStack([alice], { accounts: new MemoryAccounts(), deviceLogin: fakeDeviceLogin });
  try {
    const browser = new Browser();
    await signIn(browser, stack, alice.email, alice.password);
    const view = await me(browser, stack);
    assert.deepEqual(Object.keys(view).sort(), ['bindings', 'chats', 'csrf', 'email', 'messagingUserId', 'ownerId']);
    assert.doesNotMatch(JSON.stringify(view), /access_token|login-for:|"d":|private/i);
  } finally {
    await stack.close();
  }
});
