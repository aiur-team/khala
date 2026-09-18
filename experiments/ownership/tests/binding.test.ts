// Existing-session binding over real HTTP, real loopback redirects and real
// signatures. Messaging accounts are an in-memory double: these tests prove
// module behaviour, not provider capability (see journey.test.ts).
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Browser } from '../src/browser.ts';
import { MemoryAccounts } from '../src/provisioning.ts';
import { OwnershipError, type SessionClaim } from '../src/binding.ts';
import { connectFromLink, loadOrCreateKey, proofFor, type EndpointKey } from '../src/endpoint.ts';
import { fakeDeviceLogin, me, signIn, startStack, tempStore, type Stack } from './support.ts';

const alice = { sub: 'alice-subject', email: 'alice@example.test', password: 'disposable-a' };
const mallory = { sub: 'mallory-subject', email: 'mallory@example.test', password: 'disposable-m' };
const sessionA: SessionClaim = { harness: 'claude-code', id: 'existing-session-a', generation: 1 };

async function fixture(t: TestContext, clock?: { now: number }) {
  const accounts = new MemoryAccounts();
  const stack = await startStack([alice, mallory], { accounts, deviceLogin: fakeDeviceLogin, now: clock ? () => clock.now : undefined });
  t.after(() => stack.close());
  const aliceBrowser = new Browser();
  const view = await signIn(aliceBrowser, stack, alice.email, alice.password);
  const roomId = '!room-a:khala-test.invalid';
  accounts.members.set(roomId, new Set([view.messagingUserId]));
  aliceBrowser.human('click "New chat"');
  const created = await aliceBrowser.appRequest(`${stack.control.origin}/api/human/chats`, 'POST', view.csrf, { roomId, name: 'Launch' });
  assert.equal(created.status, 201);
  const { shareUrl } = await created.json();
  aliceBrowser.human('copy the chat link and paste it into the existing agent session');
  return { accounts, stack, aliceBrowser, owner: view, roomId, shareUrl: shareUrl as string };
}

function endpoint(t: TestContext, stack: Stack, browser: Browser, session: SessionClaim | undefined, extra: Partial<Parameters<typeof connectFromLink>[1]> = {}) {
  const store = tempStore('endpoint');
  t.after(store.remove);
  return (link: string) => connectFromLink(link, { trustedOrigin: stack.control.origin, session, storeDir: store.directory, openBrowser: url => browser.navigate(url), timeoutMs: 1_500, ...extra });
}

// Drives authorize/exchange directly to reach token-level checks.
async function bootstrapToken(stack: Stack, ownerId: string, shareUrl: string, key: EndpointKey, session = sessionA) {
  const verifier = randomBytes(32).toString('base64url');
  const redirect = stack.control.boundary.authorize(ownerId, {
    linkId: new URL(shareUrl).pathname.split('/').pop()!, session, jkt: key.jkt, state: 's',
    redirectUri: 'http://127.0.0.1:9/cb', codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
  });
  const code = new URL(redirect).searchParams.get('code')!;
  const tokenUrl = `${stack.control.origin}/api/agent/bind/token`;
  return stack.control.boundary.exchange({ code, codeVerifier: verifier, session, proof: await proofFor(key, 'POST', tokenUrl) });
}

const rejects = (promise: Promise<unknown> | (() => unknown), code: string) =>
  assert.rejects(async () => (typeof promise === 'function' ? promise() : promise), (error: unknown) => error instanceof OwnershipError && error.code === code);

test('owner browser + existing session binds the intended session with narrow capability', async t => {
  const { stack, aliceBrowser, owner, roomId, shareUrl } = await fixture(t);
  const outcome = await endpoint(t, stack, aliceBrowser, sessionA)(shareUrl);
  assert.equal(outcome.status, 'connected');
  if (outcome.status !== 'connected') return;
  const { binding, adapterToken } = outcome.result;
  assert.equal(binding.ownerId, owner.ownerId);
  assert.equal(binding.roomId, roomId);
  assert.deepEqual(binding.session, sessionA);
  assert.notEqual(binding.agentUserId, owner.messagingUserId, 'agent and human identities stay distinct');
  const claims = JSON.parse(Buffer.from(adapterToken.split('.')[1], 'base64url').toString());
  assert.deepEqual(claims.scope.split(' '), ['publish_own', 'receive_released', 'ack_delivery']);
  assert.equal(claims.cnf.jkt, outcome.key.jkt);
  const view = await me(aliceBrowser, stack);
  assert.equal(view.bindings.length, 1);
  assert.equal(view.bindings[0].sessionId, sessionA.id);
  // Projection never carries credentials or keys.
  const serialized = JSON.stringify(view);
  for (const secret of [adapterToken, outcome.result.deviceLogin.loginToken, outcome.key.jkt]) assert.ok(!serialized.includes(secret));
  // The only human-visible steps are sign-in, create chat and paste the link.
  assert.deepEqual(aliceBrowser.log.filter(entry => entry.kind === 'human-action').map(entry => entry.detail), [
    'click "Sign in" on Khala', 'enter email and password at the identity provider', 'click "New chat"',
    'copy the chat link and paste it into the existing agent session',
  ]);
});

test('copied public link on an unrelated machine cannot claim the owner', async t => {
  const { stack, owner, shareUrl } = await fixture(t);
  const strangerBrowser = new Browser();
  const outcome = await endpoint(t, stack, strangerBrowser, { harness: 'codex', id: 'stranger-session', generation: 1 })(shareUrl);
  assert.deepEqual(outcome, { status: 'blocked', reason: 'owner_browser_timeout' });
  // The stranger's browser was sent to the identity provider, not to a loopback redirect.
  assert.match(strangerBrowser.log.at(-1)!.detail, /^200 http:\/\/127\.0\.0\.1:\d+\/interaction\//);
  assert.equal(stack.control.boundary.bindingCount(), 0);
  // Signing in as themselves yields their own binding, never the creator's.
  const view = await signIn(strangerBrowser, stack, mallory.email, mallory.password);
  const own = await endpoint(t, stack, strangerBrowser, { harness: 'codex', id: 'stranger-session', generation: 1 })(shareUrl);
  assert.equal(own.status, 'connected');
  if (own.status !== 'connected') return;
  assert.equal(own.result.binding.ownerId, view.ownerId);
  assert.notEqual(own.result.binding.ownerId, owner.ownerId);
  const response = await strangerBrowser.appRequest(`${stack.control.origin}/api/human/approvals`, 'POST', view.csrf, { bindingId: 'bnd_unknown' });
  assert.equal(response.status, 403);
});

test('missing existing session is reported and never opens a browser', async t => {
  const { stack, shareUrl } = await fixture(t);
  let opened = false;
  const outcome = await endpoint(t, stack, new Browser(), undefined, { openBrowser: async () => { opened = true; } })(shareUrl);
  assert.deepEqual(outcome, { status: 'blocked', reason: 'harness_session_missing' });
  assert.equal(opened, false);
  await rejects(() => stack.control.boundary.authorize('own_x', { linkId: new URL(shareUrl).pathname.split('/').pop()!, session: undefined, jkt: 'a'.repeat(43), redirectUri: 'http://127.0.0.1:9/cb', codeChallenge: 'b'.repeat(43), state: 's' }), 'harness_session_missing');
});

test('non-loopback redirect and untrusted link origins are refused', async t => {
  const { stack, owner, shareUrl } = await fixture(t);
  const linkId = new URL(shareUrl).pathname.split('/').pop()!;
  for (const redirectUri of ['https://attacker.test/cb', 'http://localhost:9/cb', 'http://127.0.0.1/cb', 'http://user@127.0.0.1:9/cb']) {
    await rejects(() => stack.control.boundary.authorize(owner.ownerId, { linkId, session: sessionA, jkt: 'a'.repeat(43), redirectUri, codeChallenge: 'b'.repeat(43), state: 's' }), 'redirect_not_loopback');
  }
  const outcome = await endpoint(t, stack, new Browser(), sessionA, { trustedOrigin: 'https://khala.aiur.team' })(shareUrl);
  assert.deepEqual(outcome, { status: 'blocked', reason: 'untrusted_origin' });
});

test('code is one-time and PKCE/endpoint-key bound', async t => {
  const { stack, owner, shareUrl } = await fixture(t);
  const key = await endpointKey(t, 'k');
  const other = await endpointKey(t, 'o');
  const verifier = randomBytes(32).toString('base64url');
  const tokenUrl = `${stack.control.origin}/api/agent/bind/token`;
  const authorize = () => new URL(stack.control.boundary.authorize(owner.ownerId, {
    linkId: new URL(shareUrl).pathname.split('/').pop()!, session: sessionA, jkt: key.jkt, state: 's',
    redirectUri: 'http://127.0.0.1:9/cb', codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
  })).searchParams.get('code')!;
  const boundary = stack.control.boundary;
  await rejects(boundary.exchange({ code: authorize(), codeVerifier: 'wrong-verifier', session: sessionA, proof: await proofFor(key, 'POST', tokenUrl) }), 'invalid_grant');
  await rejects(boundary.exchange({ code: authorize(), codeVerifier: verifier, session: sessionA, proof: await proofFor(other, 'POST', tokenUrl) }), 'proof_key_mismatch');
  await rejects(boundary.exchange({ code: authorize(), codeVerifier: verifier, session: { ...sessionA, generation: 2 }, proof: await proofFor(key, 'POST', tokenUrl) }), 'session_mismatch');
  const code = authorize();
  await boundary.exchange({ code, codeVerifier: verifier, session: sessionA, proof: await proofFor(key, 'POST', tokenUrl) });
  await rejects(boundary.exchange({ code, codeVerifier: verifier, session: sessionA, proof: await proofFor(key, 'POST', tokenUrl) }), 'invalid_grant');
});

test('wrong audience, expired, replayed tokens and substituted generations are rejected', async t => {
  const clock = { now: Date.now() };
  const { stack, owner, shareUrl } = await fixture(t, clock);
  const boundary = stack.control.boundary;
  const redeemUrl = `${stack.control.origin}/api/agent/bootstrap/redeem`;
  const key = await endpointKey(t, 'k');
  const thief = await endpointKey(t, 't');
  const redeem = async (token: string, signer: EndpointKey, extra: { session?: SessionClaim; operationId?: string; proof?: string } = {}) =>
    boundary.redeem({ token, session: extra.session ?? sessionA, operationId: extra.operationId ?? 'operation-1', proof: extra.proof ?? await proofFor(signer, 'POST', redeemUrl, token) });

  const token = await bootstrapToken(stack, owner.ownerId, shareUrl, key);
  await rejects(redeem(token, key, { session: { ...sessionA, generation: 2 } }), 'session_generation_mismatch');
  await rejects(redeem(token, thief), 'proof_key_mismatch');
  const proof = await proofFor(key, 'POST', redeemUrl, token);
  const first = await redeem(token, key, { proof });
  await rejects(redeem(token, key, { proof }), 'proof_replayed');
  assert.deepEqual(await redeem(token, key), first, 'same operation retry returns the recorded outcome');
  await rejects(redeem(token, key, { operationId: 'operation-2' }), 'token_replayed');
  // An adapter token is signed by the same key but has the wrong audience.
  await rejects(redeem(first.adapterToken, key), 'invalid_token');
  const late = await bootstrapToken(stack, owner.ownerId, shareUrl, key);
  clock.now += 61_000;
  await rejects(redeem(late, key), 'token_expired');
  assert.equal(boundary.bindingCount(), 1);
});

test('another session of the same owner cannot silently take over the binding', async t => {
  const { stack, aliceBrowser, owner, shareUrl } = await fixture(t);
  assert.equal((await endpoint(t, stack, aliceBrowser, sessionA)(shareUrl)).status, 'connected');
  const takeover = await endpoint(t, stack, aliceBrowser, { harness: 'claude-code', id: 'other-session', generation: 1 })(shareUrl);
  assert.deepEqual(takeover, { status: 'blocked', reason: 'owner_browser_timeout' });
  assert.match(aliceBrowser.log.at(-1)!.detail, /^409 /);
  const [binding] = (await me(aliceBrowser, stack)).bindings;
  assert.equal(binding.sessionId, sessionA.id);
  await rejects(() => stack.control.boundary.authorize(owner.ownerId, { linkId: new URL(shareUrl).pathname.split('/').pop()!, session: { ...sessionA, generation: 2 }, jkt: 'a'.repeat(43), redirectUri: 'http://127.0.0.1:9/cb', codeChallenge: 'b'.repeat(43), state: 's' }), 'binding_conflict');
});

test('agent capability cannot approve or mutate policy', async t => {
  const { stack, aliceBrowser, owner, shareUrl } = await fixture(t);
  const outcome = await endpoint(t, stack, aliceBrowser, sessionA)(shareUrl);
  assert.equal(outcome.status, 'connected');
  if (outcome.status !== 'connected') return;
  const { adapterToken, binding } = outcome.result;
  const action = async (name: string, signer = outcome.key) => {
    const url = `${stack.control.origin}/api/agent/actions/${name}`;
    return fetch(url, { method: 'POST', headers: { authorization: `DPoP ${adapterToken}`, dpop: await proofFor(signer, 'POST', url, adapterToken) } });
  };
  assert.equal((await action('publish_own')).status, 200);
  assert.equal((await action('approve_release')).status, 403);
  assert.equal((await action('set_policy')).status, 403);
  assert.equal((await action('publish_own', await endpointKey(t, 'x'))).status, 401);
  // The human approval route ignores bearer credentials entirely.
  const forged = await fetch(`${stack.control.origin}/api/human/approvals`, { method: 'POST', headers: { authorization: `Bearer ${adapterToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ bindingId: binding.bindingId }) });
  assert.equal(forged.status, 401);
  const csrfless = await aliceBrowser.appRequest(`${stack.control.origin}/api/human/approvals`, 'POST', undefined, { bindingId: binding.bindingId });
  assert.equal(csrfless.status, 401);
  const approved = await aliceBrowser.appRequest(`${stack.control.origin}/api/human/approvals`, 'POST', owner.csrf, { bindingId: binding.bindingId });
  assert.equal(approved.status, 200);
});

test('lost redemption response retries the same operation without a second binding', async t => {
  const { accounts, stack, aliceBrowser, shareUrl } = await fixture(t);
  let dropped = false;
  const lossy: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (!dropped && String(input).endsWith('/bootstrap/redeem')) {
      dropped = true;
      throw new TypeError('socket closed before response');
    }
    return response;
  };
  const outcome = await endpoint(t, stack, aliceBrowser, sessionA, { transport: lossy, operationId: 'retry-operation' })(shareUrl);
  assert.ok(dropped);
  assert.equal(outcome.status, 'connected');
  assert.equal(stack.control.boundary.bindingCount(), 1);
  assert.equal([...accounts.accounts.keys()].filter(key => key.endsWith(':agent')).length, 1);
});

async function endpointKey(t: TestContext, label: string): Promise<EndpointKey> {
  const store = tempStore(label);
  t.after(store.remove);
  return loadOrCreateKey(store.directory);
}
