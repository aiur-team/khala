import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from '@playwright/test';
import { createSession, SESSION_COOKIE, csrfTokenFor } from '../../../apps/control/src/auth/sessions.ts';
import { createControlStore } from '../../../apps/control/src/runtime/control-store.ts';
import { createOwnerRoomIndex } from '../../../apps/control/src/agent-bootstrap/owner-room-index.ts';
import { createAgentBindingStore } from '../../../apps/control/src/agent-bootstrap/store.ts';
import { createLocalBlobStores } from '../../../apps/control/src/runtime/local-blob-store.ts';
import { createGateway } from '../../../apps/control/src/runtime/handler.ts';
import { registerHostedProductionRoutes } from '../../../apps/control/src/composition/hosted-production.ts';
import { openMatrixConnectorSubstrate } from '../../../apps/connector/src/substrate/matrix.ts';
import { createOwnerDeviceClient } from '../../../apps/web/src/composition/review/owner-device-client.ts';
import { createOwnerMailboxReviewClient } from '../../../apps/web/src/composition/review/owner-mailbox-client.ts';
import { sha256Digest } from '../../../packages/connector/src/storage/payloads.ts';
import { encodeMessageContent } from '../../../packages/contracts/src/messaging/events.ts';
import { ownerMatrixUserId } from '../../../apps/control/src/composition/human/matrix-identity.ts';
import { sameSessionBinding } from '../../../packages/contracts/src/delivery/binding.ts';
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

for (const { harness, expired } of [
  { harness: 'claude', expired: false },
  { harness: 'codex', expired: false },
  { harness: 'codex', expired: true },
]) {
test(`packaged ${harness} CLI ${expired ? 'refuses an expired owner operation' : 'recovers dropped admission and exchanges encrypted messages'}`,
  { timeout: 180_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'khala-installed-candidate-'));
  let synapse;
  try {
    synapse = await startClosureSynapse({ limits: {
      synapse: { memoryBytes: 1_073_741_824, cpus: 2, pids: 256 },
      postgres: { memoryBytes: 268_435_456, cpus: 1, pids: 128 },
    } });
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
  let gateway; let ownerToken; let candidateApproveUrl; let proofJkt; let requestedDeviceId; let committed;
  let agentMatrixUser;
  let browserOpens = 0; let candidateRequests = 0; let discoveryConsents = 0; let agentDeviceLogins = 0;
  let agentMatrixSends = 0;
  const participantLookupStatuses = [];
  const grants = new Set(); const bindings = new Set();
  let droppedResolve;
  const dropped = new Promise(resolve => { droppedResolve = resolve; });
  let transport;
  try { transport = await startRecoveryTransport({ onDroppedRedeem: () => droppedResolve(), async handle(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith('/_matrix/') || pathname.startsWith('/_synapse/')) {
      if (request.method === 'PUT' && pathname.includes('/send/m.room.encrypted/')) agentMatrixSends += 1;
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
    if (pathname === '/api/agent/messaging/participants') participantLookupStatuses.push(response.status);
    if (pathname === '/api/agent/bootstrap/redeem' && response.status === 200 && committed === undefined) {
      // Snapshot the first committed response; a later resume must not replace
      // the evidence that the proxy dropped from the first client process.
      committed = await response.clone().json();
    }
    return response;
  } }); }
  catch (error) { synapse.close(); rmSync(root, { recursive: true, force: true }); throw error; }
  let client; let ownerBrowser; let recoveredSession;
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
    const room = await synapse.api('/createRoom', ownerMatrix.access_token, 'POST', {
      preset: 'private_chat',
      initial_state: [
        { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
        { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'joined' } },
      ],
    });
    const roomId = room.room_id;
    assert.equal(typeof roomId, 'string');
    const roomEncryption = await synapse.api(
      `/rooms/${encodeURIComponent(roomId)}/state/m.room.encryption`, ownerMatrix.access_token, 'GET');
    assert.equal(roomEncryption.algorithm, 'm.megolm.v1.aes-sha2');
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
      clock: Date.now,
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
    ownerBrowser = await openMatrixConnectorSubstrate({
      baseUrl: synapse.baseUrl, userId: ownerUser, deviceId: 'FIXTURE_OWNER',
      accessToken: ownerMatrix.access_token, roomId,
      profileDirectory: path.join(root, 'owner-browser'),
      browserBundleDirectory: path.join(repository, 'apps/connector/dist/substrate-browser'),
      chromiumExecutablePath: chromium.executablePath(),
      participantIdFor: userId => userId === ownerUser
        ? committed?.matrix_session?.ownerParticipantId ?? null
        : userId === agentMatrixUser ? committed?.binding?.agentParticipantId ?? null : null,
    });
    let ownerKeys;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      ownerKeys = await synapse.api('/keys/query', ownerMatrix.access_token, 'POST',
        { device_keys: { [ownerUser]: ['FIXTURE_OWNER'] } });
      if (ownerKeys.device_keys?.[ownerUser]?.FIXTURE_OWNER?.keys?.['ed25519:FIXTURE_OWNER']) break;
      await delay(500);
    }
    console.log(JSON.stringify({ scope: 'owner_sdk_bootstrap', loginDeviceMatches: ownerMatrix.device_id === 'FIXTURE_OWNER',
      browserFingerprintPresent: typeof ownerBrowser.fingerprint === 'string' && ownerBrowser.fingerprint.length > 0,
      publishedDevices: Object.keys(ownerKeys.device_keys?.[ownerUser] ?? {}).length,
      publishedKeyPresent: typeof ownerKeys.device_keys?.[ownerUser]?.FIXTURE_OWNER?.keys?.['ed25519:FIXTURE_OWNER'] === 'string' }));
    assert.ok(ownerKeys.device_keys?.[ownerUser]?.FIXTURE_OWNER?.keys?.['ed25519:FIXTURE_OWNER']
      === ownerBrowser.fingerprint, 'owner SDK device key not published');
    const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], {
      cwd: path.join(repository, 'packages/agent-cli'), encoding: 'utf8', timeout: 30_000,
    }));
    const chromiumExecutable = chromium.executablePath();
    client = installRecoveryClient({ tarball: path.join(root, packed[0].filename), origin: transport.origin,
      caFile: transport.caFile, sessionId: 'controlled-candidate-session', workdir: repository,
      fixtureBrowser: true, harness, pinnedClaudeProbe: harness === 'claude',
      fixtureBrowserCertificateFile: transport.certificateFile,
      ...(process.platform === 'linux' && existsSync(chromiumExecutable) ? { chromiumExecutable } : {}) });
    const result = await client.call([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'khala_request_channel_access', arguments: { operationId: 'controlled-candidate-operation', target },
    } }]);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.replies[0]?.result?.structuredContent?.ok, true,
      `installed request outcome: ${JSON.stringify({ rpcCode: result.replies[0]?.error?.code ?? null,
        kind: result.replies[0]?.result?.structuredContent?.kind ?? null,
        code: result.replies[0]?.result?.structuredContent?.code ?? null,
        outcome: result.replies[0]?.result?.structuredContent?.outcome ?? null })}`);
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
    const statusMessage = id => ({ jsonrpc: '2.0', id, method: 'tools/call', params: {
      name: 'khala_channel_access_status', arguments: { operationId: 'controlled-candidate-operation' },
    } });
    if (expired) {
      // Move only this pending operation's durable deadline into the past. The
      // normal hosted journal must then close it on the installed status call.
      const key = 'channel-access.journal.v1';
      const journal = await control.read(key);
      assert.equal(journal.kind, 'record');
      const matches = Object.entries(journal.record.value.requests)
        .filter(([, row]) => row.requestHandle === ownerRequests[0].requestHandle);
      assert.equal(matches.length, 1);
      const [operationKey, requestRow] = matches[0];
      assert.equal((await control.compareAndSet({ key, expectedRevision: journal.record.revision,
        operationId: 'fixture-expire-owner-operation',
        next: { value: { ...journal.record.value, requests: { ...journal.record.value.requests,
          [operationKey]: { ...requestRow, deadline: new Date(Date.now() - 1_000).toISOString() } } },
        expiresAt: null } })).kind, 'applied');
      const expiredStatus = await client.call([statusMessage(3)]);
      assert.equal(new Set([result.pid, retry.pid, expiredStatus.pid]).size, 3);
      assert.equal(expiredStatus.replies[0]?.result?.structuredContent?.outcome, 'expired');
      const lateDecision = await gateway(new Request(`${transport.origin}/api/human/channel-access/decision`, {
        method: 'POST', headers: { origin: transport.origin, cookie: `${SESSION_COOKIE}=${ownerToken}`,
          'content-type': 'application/json', 'x-khala-csrf': csrfTokenFor(ownerToken) },
        body: JSON.stringify({ v: 1, requestHandle: ownerRequests[0].requestHandle,
          expectedRevision: ownerRequests[0].revision, decision: 'approve', operationId: 'fixture-expired-approval' }),
      }));
      assert.equal(lateDecision.status, 409);
      assert.equal((await lateDecision.json()).code, 'expired');
      assert.equal(grants.size, 0);
      assert.equal(bindings.size, 0);
      assert.equal(agentDeviceLogins, 0);
      assert.equal(transport.receipt().droppedRedeemResponses, 0);
      console.log(JSON.stringify({ v: 1, scope: 'installed_expired_operation', harness,
        cliProcesses: 3, ownerRequests: 1, outcome: 'expired', lateApproval: 409, grants: 0, bindings: 0,
        agentDeviceLogins: 0, droppedRedeemResponses: 0 }));
      return;
    }
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
    const lost = await client.call([statusMessage(3)], { terminateOn: dropped });
    assert.equal(lost.terminated, true);
    assert.equal(transport.receipt().droppedRedeemResponses, 1);
    assert.equal(agentDeviceLogins, 1);
    assert.equal(typeof committed?.binding?.bindingId, 'string');
    assert.equal(typeof committed?.matrix_session?.accessToken, 'string');
    assert.equal(files(client.stateDirectory).filter(item => item.endsWith('/current-binding.json')).length, 0);
    recoveredSession = client.session();
    const beforeRegistration = await recoveredSession.request(statusMessage(4));
    const routeTool = harness === 'claude' ? 'khala_status' : 'khala_read';
    const beforeRoute = await recoveredSession.request({ jsonrpc: '2.0', id: 45,
      method: 'tools/call', params: { name: routeTool, arguments: {} } });
    const beforeRead = await recoveredSession.request({ jsonrpc: '2.0', id: 5,
      method: 'tools/call', params: { name: 'khala_read', arguments: {} } });
    assert.notEqual(beforeRegistration.result?.structuredContent?.outcome, 'connected');
    assert.notEqual(beforeRoute.result?.structuredContent?.connected, true);
    assert.notEqual(beforeRead.result?.structuredContent?.kind, 'batch');
    const durableStages = () => {
      const diagnosticFile = files(client.stateDirectory).find(item => item.endsWith(`/diagnostics-${recoveredSession.pid}.jsonl`));
      if (!diagnosticFile) return [];
      return readFileSync(diagnosticFile, 'utf8').split('\n').flatMap(line => {
        try {
          const { component, stage, result } = JSON.parse(line);
          return ['subscription', 'native_ready', 'activation'].includes(component)
            && typeof stage === 'string' && typeof result === 'string'
            ? [{ component, stage, result }] : [];
        } catch { return []; }
      });
    };
    let ownerDeviceEmpty = durableStages().some(item => item.stage === 'owner_device_empty');
    for (let attempt = 0; attempt < 30 && !ownerDeviceEmpty; attempt += 1) {
      await delay(500);
      await recoveredSession.request(statusMessage(50 + attempt));
      ownerDeviceEmpty = durableStages().some(item => item.stage === 'owner_device_empty');
    }
    assert.equal(ownerDeviceEmpty, true,
      `pre-registration owner device guard not exercised: ${JSON.stringify(durableStages().slice(-8))}`);
    console.log(JSON.stringify({ scope: 'pre_owner_registration', sessionRoute: harness === 'claude' ? 'claude_env' : 'codex_meta_thread',
      status: beforeRegistration.result?.structuredContent?.outcome ?? 'absent',
      route: beforeRoute.result?.structuredContent?.kind ?? 'absent',
      read: beforeRead.result?.structuredContent?.kind ?? 'absent',
      readCode: beforeRead.result?.structuredContent?.code ?? beforeRead.error?.code ?? null,
      ownerDeviceEmpty }));
    const ownerProof = createOwnerDeviceClient({ origin: transport.origin,
      csrf: async () => csrfTokenFor(ownerToken),
      fetch: (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set('cookie', `${SESSION_COOKIE}=${ownerToken}`);
        headers.set('origin', transport.origin);
        return gateway(new Request(url, { ...init, headers }));
      },
    });
    const originalOwnerDevice = { deviceId: 'FIXTURE_OWNER', fingerprint: ownerBrowser.fingerprint,
      matrixAccessToken: ownerMatrix.access_token };
    const wrongFingerprint = `${ownerBrowser.fingerprint.slice(0, -1)}${ownerBrowser.fingerprint.endsWith('A') ? 'B' : 'A'}`;
    assert.equal(await ownerProof.register(roomId, committed.binding.bindingId, committed.binding.generation,
      { ...originalOwnerDevice, fingerprint: wrongFingerprint }), false, 'wrong owner proof admitted');
    assert.equal(await ownerProof.register(roomId, committed.binding.bindingId, committed.binding.generation,
      { ...originalOwnerDevice, deviceId: 'OTHER_OWNER_DEVICE' }), false, 'wrong owner device admitted');
    assert.equal(await ownerProof.register(roomId, committed.binding.bindingId, committed.binding.generation + 1,
      originalOwnerDevice), false, 'wrong binding generation admitted');
    assert.equal(await ownerProof.register(roomId, committed.binding.bindingId, committed.binding.generation,
      originalOwnerDevice), true, 'owner SDK device proof not pinned');
    let recoveredReply;
    const recoveryOutcomes = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      recoveredReply = await recoveredSession.request(statusMessage(6 + attempt));
      recoveryOutcomes.push(recoveredReply?.result?.structuredContent?.outcome ?? 'absent');
      if (recoveredReply?.result?.structuredContent?.outcome === 'connected') break;
      await delay(500);
    }
    assert.equal(new Set([result.pid, retry.pid, lost.pid, recoveredSession.pid]).size, 4);
    assert.equal(recoveredReply?.result?.structuredContent?.ok, true);
    console.log(JSON.stringify({ scope: 'activation_diagnostics',
      outcome: recoveredReply?.result?.structuredContent?.outcome,
      recoveryOutcomes,
      stages: recoveredSession.diagnostics(),
      participantLookupStatuses }));
    assert.equal(recoveredReply?.result?.structuredContent?.outcome, 'connected');
    const afterRoute = await recoveredSession.request({ jsonrpc: '2.0', id: 46,
      method: 'tools/call', params: { name: routeTool, arguments: {} } });
    if (harness === 'claude') {
      assert.equal(afterRoute.result?.structuredContent?.connected, true, 'session route not connected after owner proof');
    } else {
      assert.equal(afterRoute.result?.structuredContent?.kind, 'empty', 'Codex session route not ready after owner proof');
    }
    assert.equal(agentDeviceLogins, 1);
    const admissionFiles = files(client.stateDirectory).filter(item => /\/channel-access-[a-f0-9]{64}\.json$/u.test(item));
    assert.equal(admissionFiles.length, 1,
      `recovered outcome: ${recoveredReply?.result?.structuredContent?.outcome}`);
    const localAdmission = JSON.parse(readFileSync(admissionFiles[0], 'utf8'));
    assert.ok(sameSessionBinding(localAdmission.binding, committed.binding), 'original binding tuple mismatch');
    const matrixFields = ['accessToken', 'baseUrl', 'deviceId', 'ownerParticipantId', 'ownerUserId', 'roomId', 'userId'];
    assert.ok(localAdmission.matrixSession && typeof localAdmission.matrixSession === 'object'
      && Object.keys(localAdmission.matrixSession).sort().join(',') === matrixFields.slice().sort().join(',')
      && matrixFields.every(field => typeof committed.matrix_session[field] === 'string'
        && committed.matrix_session[field].length > 0
        && localAdmission.matrixSession[field] === committed.matrix_session[field]),
    'original Matrix session mismatch');
    assert.equal(grants.size, 1);
    assert.equal(bindings.size, 1);
    assert.ok(bindings.has(committed.binding.bindingId), 'durable binding mismatch');
    assert.equal(discoveryConsents, 3);
    assert.equal(transport.receipt().droppedRedeemResponses, 1);
    const ownerFetch = (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set('cookie', `${SESSION_COOKIE}=${ownerToken}`);
      headers.set('origin', transport.origin);
      return gateway(new Request(url, { ...init, headers }));
    };
    const ownerReview = createOwnerMailboxReviewClient({ origin: transport.origin,
      csrf: async () => csrfTokenFor(ownerToken), fetch: ownerFetch, waitMs: 8_000 });
    const reviewBindings = await ownerReview.bindings(roomId, AbortSignal.timeout(8_000));
    const reviewBinding = reviewBindings?.find(item => item.bindingId === committed.binding.bindingId);
    assert.equal(reviewBindings?.length, 1);
    assert.equal(reviewBinding?.device?.deviceId, committed.binding.deviceId);
    agentMatrixUser = reviewBinding.device.userId;
    assert.equal(await ownerBrowser.trustPeer(reviewBinding.device.userId,
      reviewBinding.device.deviceId, reviewBinding.device.fingerprint), undefined);
    const ownerText = 'fixture owner message for one exact release';
    const sentByOwner = await ownerBrowser.send('fixture-owner-message-1', ownerText);
    const ownerRef = { v: 1, roomId, eventId: sentByOwner.eventId,
      authorParticipantId: committed.matrix_session.ownerParticipantId,
      authorDeviceId: 'FIXTURE_OWNER',
      contentDigest: sha256Digest(encodeMessageContent({ v: 1, kind: 'text', body: ownerText })) };
    let preview;
    const previewOutcomes = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      preview = await ownerReview.review.preview({ bindingId: committed.binding.bindingId,
        candidates: [ownerRef], releaseIds: [] }, AbortSignal.timeout(8_000));
      previewOutcomes.push(preview.kind === 'ok' ? preview.body?.pending?.length ?? -1 : preview.kind);
      if (preview.kind === 'ok' && preview.body?.pending?.length === 1) break;
      await delay(500);
    }
    console.log(JSON.stringify({ scope: 'owner_preview', previewOutcomes }));
    assert.equal(preview.kind, 'ok');
    assert.equal(preview.body.pending.length, 1);
    const approved = await ownerReview.review.approve({ v: 1, commandId: 'fixture-release-one',
      roomId, bindingId: committed.binding.bindingId,
      expectedPolicyVersion: preview.body.policyVersion,
      expectedBindingGeneration: committed.binding.generation,
      selection: [ownerRef], issuedAt: new Date().toISOString() });
    assert.equal(approved.kind, 'answered');
    assert.equal(approved.body?.ok, true);
    let nativeRead;
    const readOutcomes = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      nativeRead = await recoveredSession.request({ jsonrpc: '2.0', id: 20 + attempt,
        method: 'tools/call', params: { name: 'khala_read', arguments: {} } });
      readOutcomes.push(nativeRead.result?.structuredContent?.kind ?? 'absent');
      if (nativeRead.result?.structuredContent?.kind === 'batch') break;
      await delay(500);
    }
    assert.equal(nativeRead.result?.structuredContent?.kind, 'batch');
    assert.ok(harness === 'claude'
      ? nativeRead.result?.structuredContent?.batch?.includes(ownerText)
      : nativeRead.result?.content?.some(item => item.type === 'text' && item.text.includes(ownerText)),
    'released owner message absent from native read');
    const nativeSend = await recoveredSession.request({ jsonrpc: '2.0', id: 40,
      method: 'tools/call', params: { name: 'khala_send',
        arguments: { message: 'fixture agent reply through installed client' } } });
    assert.equal(nativeSend.result?.structuredContent?.kind, 'accepted');
    assert.equal(agentMatrixSends, 1, 'native send did not reach Matrix once');
    let ownerSawReply = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const page = await ownerBrowser.source.read({ cursor: null, limit: 100 });
      ownerSawReply = page.kind === 'page' && page.events.some(event => event.kind === 'decrypted'
        && event.ref.eventId === nativeSend.result.structuredContent.eventId
        && new TextDecoder().decode(event.canonicalPayload).includes('fixture agent reply through installed client'));
      if (ownerSawReply) break;
      await delay(500);
    }
    assert.equal(ownerSawReply, true, 'owner SDK did not decrypt native send');
    console.log(JSON.stringify({ scope: 'native_review_delivery', ownerPreviewPending: 1,
      releaseAccepted: true, readOutcomes, nativeSendAccepted: true, ownerDecryptedReply: true }));
    const wrongBindingId = `${committed.binding.bindingId.slice(0, -1)}${committed.binding.bindingId.endsWith('A') ? 'B' : 'A'}`;
    const wrongBindingRead = await recoveredSession.request({ jsonrpc: '2.0', id: 41,
      method: 'tools/call', params: { name: 'khala_read', arguments: { bindingId: wrongBindingId } } });
    const wrongBindingSend = await recoveredSession.request({ jsonrpc: '2.0', id: 42,
      method: 'tools/call', params: { name: 'khala_send',
        arguments: { bindingId: wrongBindingId, message: 'fixture denied reply' } } });
    if (harness === 'claude') {
      // Claude native tools do not accept a caller-selected binding. These
      // checks prove schema rejection, not downstream authorization.
      assert.equal(wrongBindingRead.error?.code, -32602, 'unexpected read binding argument accepted');
      assert.equal(wrongBindingSend.error?.code, -32602, 'unexpected send binding argument accepted');
    } else {
      assert.equal(wrongBindingRead.result?.structuredContent?.code, 'binding_not_held');
      assert.equal(wrongBindingSend.result?.structuredContent?.code, 'not_connected');
      assert.equal(agentMatrixSends, 1, 'wrong-binding send reached Matrix');
      const foreignMeta = { threadId: 'other-controlled-session' };
      const foreignRead = await recoveredSession.request({ jsonrpc: '2.0', id: 48,
        method: 'tools/call', params: { _meta: foreignMeta, name: 'khala_read', arguments: {} } });
      const foreignSend = await recoveredSession.request({ jsonrpc: '2.0', id: 49,
        method: 'tools/call', params: { _meta: foreignMeta, name: 'khala_send',
          arguments: { message: 'fixture denied foreign reply' } } });
      const missingMetaRead = await recoveredSession.request({ jsonrpc: '2.0', id: 50,
        method: 'tools/call', params: { _meta: {}, name: 'khala_read', arguments: {} } });
      const missingMetaSend = await recoveredSession.request({ jsonrpc: '2.0', id: 51,
        method: 'tools/call', params: { _meta: {}, name: 'khala_send',
          arguments: { message: 'fixture denied unlabeled reply' } } });
      assert.equal(foreignRead.result?.structuredContent?.code, 'not_connected');
      assert.equal(foreignSend.result?.structuredContent?.code, 'not_connected');
      assert.equal(missingMetaRead.result?.structuredContent?.code, 'not_connected');
      assert.equal(missingMetaSend.result?.structuredContent?.code, 'not_connected');
      assert.equal(agentMatrixSends, 1, 'unlabeled or foreign-thread send reached Matrix');
      console.log(JSON.stringify({ scope: 'codex_route_refusals', foreignRead: 'not_connected',
        foreignSend: 'not_connected', missingThreadRead: 'not_connected',
        missingThreadSend: 'not_connected', agentMatrixSends }));
    }
    const firstPreviewBody = { bindingId: committed.binding.bindingId, candidates: [], releaseIds: [] };
    const ambiguousOperationId = `preview_${createHash('sha256').update(JSON.stringify(firstPreviewBody)).digest('hex').slice(0, 32)}_deadbeef`;
    const submitPreview = candidates => ownerFetch(`${transport.origin}/api/human/owner-mailbox/submit`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-khala-csrf': csrfTokenFor(ownerToken) },
      body: JSON.stringify({ bindingId: committed.binding.bindingId, operationId: ambiguousOperationId,
        kind: 'review_preview', body: { bindingId: committed.binding.bindingId, candidates, releaseIds: [] } }),
    });
    assert.equal((await submitPreview([])).status, 200);
    const ambiguous = await submitPreview([ownerRef]);
    assert.equal(ambiguous.status, 409, 'changed operation replay admitted');
    const beforeFence = await recoveredSession.request({ jsonrpc: '2.0', id: 47,
      method: 'tools/call', params: { name: routeTool, arguments: {} } });
    assert.equal(harness === 'claude' ? beforeFence.result?.structuredContent?.connected
      : ['empty', 'batch'].includes(beforeFence.result?.structuredContent?.kind), true,
    'native session disconnected before final refusal');
    let finalRefusal;
    if (harness === 'codex') {
      const changed = await createAgentBindingStore({ store: control }).updateBinding(
        committed.binding.bindingId, record => ({ ...record,
          revokedGeneration: record.binding.generation + 1, capability: null }));
      assert.equal(changed, 'applied', 'fixture binding revocation did not persist');
      finalRefusal = await recoveredSession.request({ jsonrpc: '2.0', id: 44,
        method: 'tools/call', params: { name: 'khala_send',
          arguments: { message: 'fixture revoked reply' } } });
    } else {
      const closing = await createOwnerRoomIndex(control).markClosing(ownerId, roomId, 'fixture-close-channel', 0);
      assert.equal(closing.kind, 'ok');
      finalRefusal = await recoveredSession.request({ jsonrpc: '2.0', id: 44,
        method: 'tools/call', params: { name: 'khala_send',
          arguments: { message: 'fixture closed reply' } } });
    }
    assert.equal(finalRefusal.result?.structuredContent?.kind, 'refused');
    assert.equal(finalRefusal.result?.structuredContent?.code, 'not_connected');
    assert.equal(agentMatrixSends, 1, 'fenced native send reached Matrix');
    console.log(JSON.stringify({ scope: 'installed_refusals', wrongProof: true, wrongDevice: true,
      wrongGeneration: true,
      wrongBindingRead: harness === 'claude' ? wrongBindingRead.error.code : wrongBindingRead.result.structuredContent.code,
      wrongBindingSend: harness === 'claude' ? wrongBindingSend.error.code : wrongBindingSend.result.structuredContent.code,
      ambiguousOperation: ambiguous.status,
      finalFence: harness === 'codex' ? 'binding_revoked' : 'room_closing',
      finalSend: finalRefusal.result?.structuredContent?.kind ?? 'absent',
      finalCode: finalRefusal.result?.structuredContent?.code ?? null,
      agentMatrixSends }));
    console.log(JSON.stringify({ v: 1, scope: 'installed_access_recovery', harness, cliProcesses: 4, browserOpens,
      candidateRequests, discoveryConsents, ownerRequests: ownerRequests.length,
      grants: grants.size, bindings: bindings.size, agentDeviceLogins,
      droppedRedeemResponses: 1, originalBindingPreserved: true }));
  } finally {
    let cleanupFailure;
    for (const cleanup of [
      () => recoveredSession?.close(), () => client?.close(), () => ownerBrowser?.close(),
      () => transport.close(), () => synapse.close(), () => rmSync(root, { recursive: true, force: true }),
    ]) {
      try { await cleanup(); } catch (error) { cleanupFailure ??= error; }
    }
    if (cleanupFailure) throw cleanupFailure;
  }
});
}
