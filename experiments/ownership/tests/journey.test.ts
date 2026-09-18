// Live normal-path journey: real disposable OIDC provider, real Synapse/Postgres,
// real loopback browser binding, endpoint-created Matrix device. Requires Docker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Browser } from '../src/browser.ts';
import { DeviceLoginIssuer, SynapseAccounts, ensureAccount, localpartFor } from '../src/provisioning.ts';
import { connectFromLink, proofFor } from '../src/endpoint.ts';
import { me, signIn, startStack, tempStore } from './support.ts';
import { SERVER_NAME, startSynapse } from './synapse.ts';

async function matrix(base: string, token: string | undefined, path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`Matrix ${path.split('?')[0]} HTTP ${response.status} ${json.errcode ?? ''}`);
  return json;
}

test('OAuth sign-in → chat → existing session bound → agent device speaks in the room', { timeout: 300_000 }, async t => {
  const started = Date.now();
  const deviceLogin = await DeviceLoginIssuer.create('https://khala.aiur.team');
  const synapse = await startSynapse(deviceLogin.synapseJwtConfig());
  t.after(synapse.close);
  const accounts = new SynapseAccounts(synapse.baseUrl, synapse.adminToken, SERVER_NAME);
  const alice = { sub: 'alice-subject', email: 'alice@example.test', password: randomBytes(12).toString('hex') };
  const stack = await startStack([alice], { accounts, deviceLogin });
  t.after(() => stack.close());
  const evidence: Record<string, unknown> = { synapse_version: synapse.version, node: process.version };

  // Human: sign in with the provider. Web app: automatic Matrix account + browser device.
  const browser = new Browser();
  const owner = await signIn(browser, stack, alice.email, alice.password);
  const { loginToken } = await (await browser.appRequest(`${stack.control.origin}/api/human/messaging/device-login`, 'POST', owner.csrf)).json();
  const human = await matrix(synapse.baseUrl, undefined, '/_matrix/client/v3/login', { type: 'org.matrix.login.jwt', token: loginToken, initial_device_display_name: 'Khala web' });
  assert.equal(human.user_id, owner.messagingUserId);

  // Human: "New chat". Web app creates the room with the human's own device.
  browser.human('click "New chat"');
  const room = await matrix(synapse.baseUrl, human.access_token, '/_matrix/client/v3/createRoom', { visibility: 'private', preset: 'private_chat', name: 'Launch' });
  const created = await browser.appRequest(`${stack.control.origin}/api/human/chats`, 'POST', owner.csrf, { roomId: room.room_id, name: 'Launch' });
  assert.equal(created.status, 201);
  const { shareUrl } = await created.json();
  browser.human('copy the chat link and paste it into the existing agent session');

  // Agent: its existing session resolves the link and opens the owner's browser.
  const session = { harness: 'claude-code', id: `existing-${randomBytes(6).toString('hex')}`, generation: 1 };
  const store = tempStore('journey');
  t.after(store.remove);
  const outcome = await connectFromLink(shareUrl, { trustedOrigin: stack.control.origin, session, storeDir: store.directory, openBrowser: url => browser.navigate(url), homeserver: synapse.baseUrl });
  assert.equal(outcome.status, 'connected');
  if (outcome.status !== 'connected') return;
  const agent = outcome.matrix!;
  assert.equal(agent.userId, outcome.result.binding.agentUserId);
  assert.notEqual(agent.userId, human.user_id, 'agent participant is not the human account');
  const whoami = await matrix(synapse.baseUrl, agent.accessToken, '/_matrix/client/v3/account/whoami');
  assert.equal(whoami.device_id, agent.deviceId, 'device created by the endpoint itself');

  // Web app: sees the binding in its projection and invites the agent participant automatically.
  const projection = await me(browser, stack);
  assert.equal(projection.bindings[0].sessionId, session.id);
  for (const secret of [agent.accessToken, outcome.result.adapterToken, outcome.result.deviceLogin.loginToken]) assert.ok(!JSON.stringify(projection).includes(secret));
  await matrix(synapse.baseUrl, human.access_token, `/_matrix/client/v3/rooms/${encodeURIComponent(room.room_id)}/invite`, { user_id: agent.userId });
  await matrix(synapse.baseUrl, agent.accessToken, `/_matrix/client/v3/join/${encodeURIComponent(room.room_id)}`, {});
  const sent = await matrix(synapse.baseUrl, agent.accessToken, `/_matrix/client/v3/rooms/${encodeURIComponent(room.room_id)}/send/m.room.message/${randomBytes(8).toString('hex')}`, { msgtype: 'm.text', body: 'synthetic-agent-marker' }, 'PUT');
  const seen = await matrix(synapse.baseUrl, human.access_token, `/_matrix/client/v3/rooms/${encodeURIComponent(room.room_id)}/event/${encodeURIComponent(sent.event_id)}`);
  assert.equal(seen.sender, agent.userId);

  // Only the control plane's key can mint Matrix devices: a self-signed assertion for the human fails.
  const forger = await DeviceLoginIssuer.create('https://khala.aiur.team');
  await assert.rejects(matrix(synapse.baseUrl, undefined, '/_matrix/client/v3/login', { type: 'org.matrix.login.jwt', token: await forger.issue(human.user_id), device_id: 'FORGED' }), /HTTP 403/);

  // Copied link on an unrelated machine: no owner session, no binding.
  const strangerStore = tempStore('stranger');
  t.after(strangerStore.remove);
  const stranger = await connectFromLink(shareUrl, { trustedOrigin: stack.control.origin, session: { harness: 'codex', id: 'stranger', generation: 1 }, storeDir: strangerStore.directory, openBrowser: url => new Browser().navigate(url), timeoutMs: 2_000 });
  assert.deepEqual(stranger, { status: 'blocked', reason: 'owner_browser_timeout' });
  assert.equal(stack.control.boundary.bindingCount(), 1);

  // Forged human approval using the agent's capability fails; the human's succeeds.
  const approveUrl = `${stack.control.origin}/api/agent/actions/approve_release`;
  const forged = await fetch(approveUrl, { method: 'POST', headers: { authorization: `DPoP ${outcome.result.adapterToken}`, dpop: await proofFor(outcome.key, 'POST', approveUrl, outcome.result.adapterToken) } });
  assert.equal(forged.status, 403);
  const bearer = await fetch(`${stack.control.origin}/api/human/approvals`, { method: 'POST', headers: { authorization: `Bearer ${outcome.result.adapterToken}` }, body: '{}' });
  assert.equal(bearer.status, 401);

  // Email change at the provider: same owner, same Matrix account.
  stack.idp.setEmail(alice.sub, 'alice@renamed.test');
  const again = await signIn(new Browser(), stack, 'alice@renamed.test', alice.password);
  assert.equal(again.ownerId, owner.ownerId);
  assert.equal(again.messagingUserId, owner.messagingUserId);

  // Lost provisioning response against real Synapse reconciles to one account.
  let dropped = false;
  const lossy = new SynapseAccounts(synapse.baseUrl, synapse.adminToken, SERVER_NAME, async (input, init) => {
    const response = await fetch(input, init);
    if (!dropped && init?.method === 'PUT') { dropped = true; throw new TypeError('socket closed before response'); }
    return response;
  });
  const externalId = `own_${randomBytes(6).toString('hex')}`;
  const userId = await ensureAccount(lossy, externalId, 'human', 'Lost response');
  assert.ok(dropped);
  assert.equal(await accounts.lookup(externalId), userId);
  assert.equal(await accounts.countByExternalPrefix(localpartFor(externalId, 'human')), 1);

  evidence.duration_ms = Date.now() - started;
  evidence.human_actions = browser.log.filter(entry => entry.kind === 'human-action').map(entry => entry.detail);
  evidence.pages = browser.log.filter(entry => entry.kind === 'page').map(entry => entry.detail.replace(/127\.0\.0\.1:\d+/, 'loopback'));
  evidence.binding = { harness: session.harness, generation: session.generation, agent_distinct_from_human: true, endpoint_device_created_by_endpoint: true };
  t.diagnostic(JSON.stringify(evidence));
});
