import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from '@playwright/test';
import { createSession, SESSION_COOKIE, csrfTokenFor } from '../../../apps/control/src/auth/sessions.ts';
import { createControlStore } from '../../../apps/control/src/runtime/control-store.ts';
import { createLocalBlobStores } from '../../../apps/control/src/runtime/local-blob-store.ts';
import { createGateway } from '../../../apps/control/src/runtime/handler.ts';
import { registerHostedProductionRoutes } from '../../../apps/control/src/composition/hosted-production.ts';
import { ownerMatrixUserId } from '../../../apps/control/src/composition/human/matrix-identity.ts';
import { agentMatrixIdentity } from '../../../apps/control/src/composition/agent/matrix-admission.ts';
import { thumbprint } from '../../../apps/control/src/agent-bootstrap/proof.ts';
import { createDigests } from '../../../apps/control/src/invitations/internal.ts';
import { startRecoveryTransport } from '../../../scripts/fixtures/hosted-recovery.mjs';
import { installRecoveryClient } from '../../../scripts/fixtures/installed-recovery-client.mjs';
import { startClosureSynapse } from '../fixtures/closure-synapse.ts';

const repository = fileURLToPath(new URL('../../..', import.meta.url));
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const item = path.join(directory, entry.name);
    return entry.isDirectory() ? files(item) : [item];
  });
}

test('packaged CLI files an owner-visible access request through fixture HTTPS and Synapse', { timeout: 180_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'khala-installed-candidate-'));
  let synapse;
  try {
    synapse = await startClosureSynapse({ limits: {
      synapse: { memoryBytes: 1_073_741_824, cpus: 2, pids: 256 },
      postgres: { memoryBytes: 268_435_456, cpus: 1, pids: 128 },
    } });
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
  let gateway; let ownerToken; let candidateApproveUrl; let proofJkt; let requestedDeviceId; let committed;
  let browserOpens = 0; let candidateRequests = 0; let discoveryConsents = 0; let agentDeviceLogins = 0;
  const grants = new Set(); const bindings = new Set();
  let transport;
  try { transport = await startRecoveryTransport({ async handle(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith('/_matrix/') || pathname.startsWith('/_synapse/')) {
      const target = synapse.baseUrl + request.url.slice(transport.origin.length);
      return fetch(target, { method: request.method, headers: request.headers,
        ...(['GET', 'HEAD'].includes(request.method) ? {} : { body: await request.arrayBuffer() }) });
    }
    if (pathname === '/__fixture/browser-open' && request.method === 'POST') {
      const input = await request.json();
      const target = new URL(input.url);
      browserOpens += 1;
      if (target.origin !== transport.origin) return new Response(null, { status: 403 });
      if (target.pathname === '/api/human/channel-discovery/authority/approve') {
        candidateApproveUrl = target.href;
        return new Response(null, { status: 204 });
      }
      if (target.pathname === '/api/human/channel-discovery/bootstrap/authorize' && ownerToken) {
        const form = new URLSearchParams(target.searchParams);
        form.set('csrf_token', csrfTokenFor(ownerToken));
        form.set('decision', 'allow');
        const consent = await gateway(new Request(target.href, { method: 'POST', headers: {
          origin: transport.origin, cookie: `${SESSION_COOKIE}=${ownerToken}`,
          'content-type': 'application/x-www-form-urlencoded',
        }, body: form }));
        if (consent.status !== 303) return new Response(null, { status: 503 });
        const callback = consent.headers.get('location');
        if (!callback || new URL(callback).hostname !== '127.0.0.1') return new Response(null, { status: 503 });
        const delivered = await fetch(callback);
        if (delivered.status !== 200) return new Response(null, { status: 503 });
        discoveryConsents += 1;
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 403 });
    }
    if (pathname === '/api/agent/channel-discovery/authority/candidate') {
      candidateRequests += 1;
      const encoded = request.headers.get('dpop')?.split('.')[0];
      if (encoded) proofJkt = thumbprint(JSON.parse(Buffer.from(encoded, 'base64url')).jwk.x);
    }
    if (pathname === '/api/agent/channel-access/exchange') {
      requestedDeviceId = (await request.clone().json()).deviceId;
    }
    const response = gateway ? await gateway(request) : new Response(null, { status: 503 });
    if (pathname === '/api/agent/bootstrap/redeem' && response.status === 200) {
      committed = await response.clone().json();
    }
    return response;
  } }); }
  catch (error) { synapse.close(); rmSync(root, { recursive: true, force: true }); throw error; }
  let client;
  try {
    const env = { PUBLIC_APP_ORIGIN: transport.origin,
      PUBLIC_HOMESERVER_ORIGIN: transport.origin,
      OIDC_ISSUER: 'https://issuer.example.test', OIDC_CLIENT_ID: 'khala-fixture',
      OIDC_CLIENT_SECRET: randomBytes(32).toString('base64url'),
      CONTROL_STATE_NAMESPACE: 'khala-installed-candidate', MATRIX_SERVER_NAME: synapse.serverName,
      MATRIX_REGISTRATION_SHARED_SECRET: synapse.registrationSharedSecret,
      MATRIX_PASSWORD_DERIVATION_SECRET: randomBytes(32).toString('base64url'),
      INVITATION_HMAC_SECRET: randomBytes(32).toString('base64url'),
      KHALA_ADMISSION_MODE: 'explicit_browser_consent', KHALA_LOCAL_AUTH: 'enabled', NODE_ENV: 'development' };
    const localStores = createLocalBlobStores(path.join(root, 'control'));
    const stores = name => {
      const backing = localStores(name);
      return { ...backing, async setJSON(key, data, options) {
        const result = await backing.setJSON(key, data, options);
        if (result.modified && name.endsWith('-records')) {
          if (key.startsWith('channel-access-grant/')) grants.add(key);
          if (key.startsWith('channel-access-operation-binding/') && !key.endsWith('#issuance')
            && typeof data?.value?.bindingId === 'string') bindings.add(data.value.bindingId);
        }
        return result;
      } };
    };
    const control = createControlStore({ records: stores(`${env.CONTROL_STATE_NAMESPACE}-records`),
      operations: stores(`${env.CONTROL_STATE_NAMESPACE}-operations`), clock: Date.now });
    const ownerId = 'owner_fixture';
    const ownerUser = ownerMatrixUserId(ownerId, synapse.serverName);
    const ownerPassword = createHmac('sha256', env.MATRIX_PASSWORD_DERIVATION_SECRET)
      .update('khala-matrix-password-v1\0').update(ownerId).digest('base64url');
    const ownerMatrix = await synapse.provision(ownerUser, 'FIXTURE_OWNER', ownerPassword);
    const room = await synapse.api('/createRoom', ownerMatrix.access_token, 'POST', { preset: 'private_chat' });
    const roomId = room.room_id;
    assert.equal(typeof roomId, 'string');
    const inviteRef = 'inv_installed_fixture';
    const digests = createDigests(env.INVITATION_HMAC_SECRET);
    assert.equal((await control.compareAndSet({ key: digests.inviteKey(inviteRef), expectedRevision: null,
      operationId: 'fixture-share-link', next: { value: { v: 1, roomId, creatorOwnerId: ownerId,
        inviteRefDigest: digests.inviteRef(inviteRef), policyRevision: 1,
        policy: { v: 1, kind: 'link', history: 'none' }, status: 'active', expiresAt: null,
        lastAuthorizedOperationDigest: null }, expiresAt: null } })).kind, 'applied');
    assert.equal((await control.compareAndSet({
      key: `matrix.room-authority.v1.${createHash('sha256').update(roomId).digest('hex')}`,
      expectedRevision: null, operationId: 'fixture-room-authority',
      next: { value: { v: 1, roomId, ownerId }, expiresAt: null },
    })).kind, 'applied');
    const owner = await createSession(control, randomBytes, { ownerId: 'owner_fixture',
      identity: { issuer: env.OIDC_ISSUER, subject: 'fixture-owner', verifiedEmail: 'owner@example.test' },
      expiresAtMs: Date.now() + 3_600_000 });
    assert.equal(owner.kind, 'created');
    ownerToken = owner.token;
    gateway = createGateway({ registrations: registerHostedProductionRoutes({ env, stores,
      async fetch(url, init) {
        const target = new URL(url);
        assert.equal(target.origin, transport.origin);
        assert.ok(target.pathname.startsWith('/_matrix/') || target.pathname.startsWith('/_synapse/'));
        const response = await fetch(synapse.baseUrl + target.pathname + target.search, init);
        if (new URL(url).pathname === '/_matrix/client/v3/login' && response.status === 200
          && requestedDeviceId && JSON.parse(init.body).device_id === requestedDeviceId) agentDeviceLogins += 1;
        return response;
      },
    }),
      absentPrefixes: [], appOrigin: transport.origin });
    const target = `${transport.origin}/join/${inviteRef}`;
    execFileSync(process.execPath, ['packages/agent-cli/scripts/bundle.mjs'], { cwd: repository,
      stdio: 'ignore', timeout: 60_000 });
    const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], {
      cwd: path.join(repository, 'packages/agent-cli'), encoding: 'utf8', timeout: 30_000,
    }));
    const chromiumExecutable = chromium.executablePath();
    client = installRecoveryClient({ tarball: path.join(root, packed[0].filename), origin: transport.origin,
      caFile: transport.caFile, sessionId: 'controlled-candidate-session', workdir: repository,
      fixtureBrowser: true, pinnedClaudeProbe: true,
      ...(process.platform === 'linux' && existsSync(chromiumExecutable) ? { chromiumExecutable } : {}) });
    const result = await client.call([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'khala_request_channel_access', arguments: { operationId: 'controlled-candidate-operation', target },
    } }]);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.replies[0]?.result?.structuredContent?.ok, true);
    assert.equal(result.replies[0]?.result?.structuredContent?.outcome, 'pending_owner');
    assert.equal(candidateRequests, 1);
    assert.equal(browserOpens, 1);
    assert.equal(typeof candidateApproveUrl, 'string');
    const approval = await gateway(new Request(`${transport.origin}/api/human/channel-discovery/authority/approve`, {
      method: 'POST', headers: { origin: transport.origin, cookie: `${SESSION_COOKIE}=${ownerToken}`,
        'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ candidate: new URL(candidateApproveUrl).searchParams.get('candidate'),
        csrf_token: csrfTokenFor(ownerToken), decision: 'approve' }),
    }));
    assert.equal(approval.status, 200);
    const retry = await client.call([{ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'khala_request_channel_access', arguments: { operationId: 'controlled-candidate-operation', target },
    } }]);
    assert.notEqual(result.pid, retry.pid);
    assert.deepEqual(retry.diagnostics, []);
    assert.equal(retry.replies[0]?.result?.structuredContent?.ok, true);
    assert.equal(retry.replies[0]?.result?.structuredContent?.outcome, 'pending_owner');
    assert.equal(discoveryConsents, 1);
    const inbox = await gateway(new Request(`${transport.origin}/api/human/channel-access/inbox`, {
      headers: { cookie: `${SESSION_COOKIE}=${ownerToken}` },
    }));
    assert.equal(inbox.status, 200);
    const ownerRequests = (await inbox.json()).requests;
    assert.equal(ownerRequests.length, 1);
    assert.equal(typeof proofJkt, 'string');
    const agentIdentity = agentMatrixIdentity(ownerId, { harness: 'proof-key', sessionId: `agent_${proofJkt}`,
      generation: 0 }, synapse.serverName);
    const agentPassword = createHmac('sha256', env.MATRIX_PASSWORD_DERIVATION_SECRET)
      .update('khala-matrix-agent-password-v1\0').update(agentIdentity.userId).digest('base64url');
    await synapse.provision(agentIdentity.userId, 'FIXTURE_ACCOUNT', agentPassword);
    const decisionRequest = new Request(`${transport.origin}/api/human/channel-access/decision`, {
      method: 'POST', headers: { origin: transport.origin, cookie: `${SESSION_COOKIE}=${ownerToken}`,
        'content-type': 'application/json', 'x-khala-csrf': csrfTokenFor(ownerToken) },
      body: JSON.stringify({ v: 1, requestHandle: ownerRequests[0].requestHandle,
        expectedRevision: ownerRequests[0].revision, decision: 'approve', operationId: 'fixture-access-approval' }),
    });
    const decision = await gateway(decisionRequest);
    assert.equal(decision.status, 200);
    const statusMessage = id => ({ jsonrpc: '2.0', id, method: 'tools/call', params: {
      name: 'khala_channel_access_status', arguments: { operationId: 'controlled-candidate-operation' },
    } });
    const lost = await client.call([statusMessage(3)]);
    assert.equal(typeof lost.replies[0]?.result?.structuredContent?.ok, 'boolean');
    assert.equal(transport.receipt().droppedRedeemResponses, 1);
    assert.equal(agentDeviceLogins, 1);
    assert.equal(typeof committed?.binding?.bindingId, 'string');
    assert.equal(files(client.stateDirectory).filter(item => item.endsWith('/current-binding.json')).length, 0);
    const recovered = await client.call([statusMessage(4)]);
    assert.equal(new Set([result.pid, retry.pid, lost.pid, recovered.pid]).size, 4);
    assert.equal(recovered.replies[0]?.result?.structuredContent?.ok, true);
    assert.equal(agentDeviceLogins, 1);
    const admissionFiles = files(client.stateDirectory).filter(item => /\/channel-access-[a-f0-9]{64}\.json$/u.test(item));
    assert.equal(admissionFiles.length, 1,
      `recovered outcome: ${recovered.replies[0]?.result?.structuredContent?.outcome}`);
    const localAdmission = JSON.parse(readFileSync(admissionFiles[0], 'utf8'));
    assert.ok(localAdmission.binding.bindingId === committed.binding.bindingId, 'local admission binding mismatch');
    assert.equal(grants.size, 1);
    assert.equal(bindings.size, 1);
    assert.ok(bindings.has(committed.binding.bindingId), 'durable binding mismatch');
    assert.equal(discoveryConsents, 3);
    assert.equal(transport.receipt().droppedRedeemResponses, 1);
    console.log(JSON.stringify({ v: 1, scope: 'installed_access_recovery', cliProcesses: 4, browserOpens,
      candidateRequests, discoveryConsents, ownerRequests: ownerRequests.length,
      grants: grants.size, bindings: bindings.size, agentDeviceLogins,
      droppedRedeemResponses: 1, originalBindingPreserved: true }));
  } finally {
    client?.close(); await transport.close(); synapse.close(); rmSync(root, { recursive: true, force: true });
  }
});
