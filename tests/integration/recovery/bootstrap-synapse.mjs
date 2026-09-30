// Real bootstrap/pairing/store/Matrix adapters. Owner decisions are invoked by the fixture,
// not a production authenticated browser. This is not hosted channel-access recovery.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startClosureSynapse } from '../fixtures/closure-synapse.ts';
import { startRecoveryTransport } from '../../../scripts/fixtures/hosted-recovery.mjs';
import { createLocalBlobStores } from '../../../apps/control/src/runtime/local-blob-store.ts';
import { createControlStore } from '../../../apps/control/src/runtime/control-store.ts';
import { createPairingPolicy } from '../../../apps/control/src/pairing/policy.ts';
import { createPairingStore } from '../../../apps/control/src/pairing/store.ts';
import { createAgentBootstrapHandlers } from '../../../apps/control/src/agent-bootstrap/handler.ts';
import { agentMatrixIdentity, createMatrixAgentAdmission } from '../../../apps/control/src/composition/agent/matrix-admission.ts';
import { ownerMatrixUserId } from '../../../apps/control/src/composition/human/matrix-identity.ts';
import { createProofSigner } from '../../../packages/connector/src/bootstrap/proof.ts';

const repository = fileURLToPath(new URL('../../..', import.meta.url));
const ownerId = 'owner_controlled';
const session = { harness: 'codex', sessionId: 'controlled-synapse-session', generation: 3 };
const deviceId = 'CONTROLLED_DEVICE';

export async function startApprovedBootstrapFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'khala-approved-bootstrap-'));
  let synapse; let transport;
  const key = generateKeyPairSync('ed25519').privateKey;
  const signer = createProofSigner(key);
  const proofFile = path.join(root, 'proof.pem');
  const requestFile = path.join(root, 'request.json');
  writeFileSync(proofFile, key.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  const passwordSecret = randomBytes(32).toString('base64url');
  const invitationSecret = randomBytes(32).toString('base64url');
  const policy = createPairingPolicy({ v: 1, activeKeyId: 'fixture', keys: [{ id: 'fixture', key: randomBytes(32) }] });
  const grants = new Set(); const bindings = new Set();
  let agentDeviceLogins = 0; let totalAdapterLogins = 0;
  const matrixResults = [];
  let pairing; let bootstrap; let created; let claimed; let grant; let committed;
  try {
    synapse = await startClosureSynapse({ limits: {
      synapse: { memoryBytes: 1_073_741_824, cpus: 2, pids: 256 },
      postgres: { memoryBytes: 268_435_456, cpus: 1, pids: 128 },
    } });
    const ownerUser = ownerMatrixUserId(ownerId, synapse.serverName);
    const ownerPassword = createHmac('sha256', passwordSecret).update('khala-matrix-password-v1\0').update(ownerId).digest('base64url');
    const ownerSession = await synapse.provision(ownerUser, 'CONTROLLED_OWNER', ownerPassword);
    const room = await synapse.api('/createRoom', ownerSession.access_token, 'POST', { preset: 'private_chat' });
    const roomId = room.room_id;
    assert.equal(typeof roomId, 'string');
    // Provision the disposable account separately; this slice exercises admission/device issuance,
    // not account creation. No requested-device login happens during fixture provisioning.
    const agentIdentity = agentMatrixIdentity(ownerId, session, synapse.serverName);
    const agentPassword = createHmac('sha256', passwordSecret).update('khala-matrix-agent-password-v1\0')
      .update(agentIdentity.userId).digest('base64url');
    const preparedAgent = await synapse.provision(agentIdentity.userId, 'FIXTURE_ACCOUNT', agentPassword);
    await synapse.api(`/profile/${encodeURIComponent(agentIdentity.userId)}/displayname`,
      preparedAgent.access_token, 'PUT', { displayname: 'Controlled fixture account' });

    async function compose() {
      const blobs = createLocalBlobStores(path.join(root, 'control'));
      const backing = createControlStore({ records: blobs('records'), operations: blobs('operations'), clock: Date.now });
      const store = { ...backing, async compareAndSet(input) {
        const result = await backing.compareAndSet(input);
        if (result.kind === 'applied') {
          if (input.next.value?.recordType === 'pairing_grant') grants.add(input.key);
          const bindingId = input.next.value?.binding?.bindingId;
          if (typeof bindingId === 'string') bindings.add(bindingId);
        }
        return result;
      } };
      pairing = createPairingStore({ store, policy, clock: Date.now });
      const matrix = createMatrixAgentAdmission({ homeserverOrigin: synapse.baseUrl,
        allowInsecureLoopback: true, serverName: synapse.serverName,
        registrationSharedSecret: synapse.registrationSharedSecret, passwordDerivationSecret: passwordSecret,
        invitationHmacSecret: invitationSecret, store, clock: Date.now,
        async fetch(url, init) {
          const response = await fetch(url, init);
          const suffix = new URL(url).pathname;
          const stage = suffix.endsWith('/login') ? 'login' : suffix.includes('/register') ? 'register'
            : suffix.includes('/profile/') ? 'profile' : suffix.includes('/join/') ? 'join'
            : suffix.endsWith('/invite') ? 'invite' : 'membership';
          matrixResults.push({ stage, status: response.status });
          if (new URL(url).pathname === '/_matrix/client/v3/login' && response.status === 200) {
            totalAdapterLogins += 1;
            if (JSON.parse(init.body).device_id === deviceId) agentDeviceLogins += 1;
          }
          return response;
        },
      });
      bootstrap = createAgentBootstrapHandlers({ origin: transport.origin, store, clock: Date.now, random: randomBytes,
        authenticate: async () => ({ kind: 'signed_out' }), inviteFromLink: () => null,
        admissionFor: () => ({ inspect: async () => 'forbidden' }), admissionPolicy: async () => 'deny',
        agents: matrix.agents, agentDeviceSession: matrix.deviceSession, pairingGrants: pairing.grantPort,
        legacyMigrationWritesEnabled: false });
    }
    transport = await startRecoveryTransport({ async handle(request) {
      const route = bootstrap.agent.find(entry => entry.path === new URL(request.url).pathname);
      if (!route) return Response.json({ code: 'not_found' }, { status: 404 });
      const response = await route.handle(request);
      if (response.status >= 500) console.log(JSON.stringify({ scope: 'bootstrap_fixture_diagnostic',
        status: response.status, matrixResults, bindings: bindings.size, grants: grants.size }));
      if (response.status === 200 && new URL(request.url).pathname === '/api/agent/bootstrap/redeem') {
        committed = await response.clone().json(); // Private fixture state, never a public receipt.
      }
      return response;
    } });
    await compose();
    const cleanup = async () => {
      try { await transport?.close(); }
      finally { try { synapse?.close(); } finally { rmSync(root, { recursive: true, force: true }); } }
    };
    return {
      counts: () => ({ grants: grants.size, bindings: bindings.size, agentDeviceLogins, totalAdapterLogins }),
      droppedRedeemResponses: () => transport.receipt().droppedRedeemResponses,
      async request() {
        created = await pairing.create({ ownerId, channelId: roomId, origin: transport.origin,
          descriptorId: 'controlled-descriptor', operationId: 'controlled-create' });
        assert.equal(created.kind, 'created');
        claimed = await pairing.claim({ code: created.code, operationId: 'controlled-claim', jkt: signer.jkt,
          ...session, deviceId, evidenceDigest: 'A'.repeat(43) });
        assert.equal(claimed.kind, 'claimed');
        const pending = await pairing.result({ requestHandle: created.requestHandle, receipt: claimed.receipt,
          operationId: 'controlled-result', jkt: signer.jkt });
        assert.equal(pending.kind, 'result');
        return pending.value.state;
      },
      async approve() {
        const inspected = await pairing.inspect({ ownerId, requestHandle: created.requestHandle });
        assert.equal(inspected.kind, 'found');
        assert.ok(inspected.projection.claim);
        const decision = await pairing.decide({ ownerId, requestHandle: created.requestHandle,
          revision: inspected.revision, claimFingerprint: inspected.projection.claim.fingerprint,
          decision: 'approve', operationId: 'controlled-approve' });
        assert.equal(decision.kind, 'decided');
        const approved = await pairing.result({ requestHandle: created.requestHandle, receipt: claimed.receipt,
          operationId: 'controlled-result', jkt: signer.jkt });
        assert.equal(approved.kind, 'result');
        grant = approved.value.grant;
        assert.equal(typeof grant, 'string');
        return approved.value.state;
      },
      async client(overrides = {}) {
        writeFileSync(requestFile, JSON.stringify({ grant, redeem: transport.origin + '/api/agent/bootstrap/redeem',
          operationId: 'controlled-redeem', session, deviceId, ...overrides }), { mode: 0o600 });
        return new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ['--import', 'tsx', '--conditions=khala-source', '--input-type=module', '-e', `
            import { readFileSync } from 'node:fs';
            import { createPrivateKey } from 'node:crypto';
            import { createProofSigner } from './packages/connector/src/bootstrap/proof.ts';
            import { createHttpAdmission } from './packages/connector/src/bootstrap/loopback.ts';
            const [proofFile, requestFile] = process.argv.slice(1);
            const input = JSON.parse(readFileSync(requestFile));
            const signer = createProofSigner(createPrivateKey(readFileSync(proofFile)));
            const result = await createHttpAdmission({ signer }).redeem({ operationId: input.operationId, grant: {
              secret: input.grant, redeem: input.redeem, session: input.session, deviceId: input.deviceId,
              method: 'pairing-code-v1', expiresAt: Date.now() + 60_000
            } });
            console.log(JSON.stringify({ kind: result.kind, ...(result.kind === 'refused' ? { code: result.code } : {}) }));
          `, proofFile, requestFile], { cwd: repository,
            env: { PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: transport.caFile }, stdio: ['ignore', 'pipe', 'pipe'] });
          let output = '';
          child.stdout.on('data', chunk => { output += chunk; }); child.stderr.resume();
          const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
          child.once('error', () => { clearTimeout(timer); reject(new Error('controlled_client_start_failed')); });
          child.once('close', code => {
            clearTimeout(timer);
            if (code !== 0) { reject(new Error('controlled_client_failed')); return; }
            try { resolve({ pid: child.pid, ...JSON.parse(output) }); } catch { reject(new Error('controlled_client_reply_invalid')); }
          });
        });
      },
      restartControl: compose,
      async originalBindingPreserved() {
        assert.ok(committed?.binding?.bindingId);
        const found = await bootstrap.capabilities.lookupBinding(committed.binding.bindingId);
        return found.kind === 'found' && found.status === 'active' && found.deviceId === deviceId && found.generation === session.generation;
      },
      async matrixExchange() {
        // Plain Matrix fixture exchange through the server-retained original session.
        // This is deliberately not a recovered native encrypted connector read/send.
        const agent = committed.matrix_session;
        assert.ok(agent);
        const event = await synapse.api(`/rooms/${encodeURIComponent(roomId)}/send/m.room.message/controlled-human`,
          ownerSession.access_token, 'PUT', { msgtype: 'm.text', body: 'controlled synthetic human message' });
        const received = await synapse.api(`/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(event.event_id)}`,
          agent.accessToken, 'GET');
        const reply = await synapse.api(`/rooms/${encodeURIComponent(roomId)}/send/m.room.message/controlled-agent`,
          agent.accessToken, 'PUT', { msgtype: 'm.text', body: 'controlled synthetic agent reply' });
        const visible = await synapse.api(`/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(reply.event_id)}`,
          ownerSession.access_token, 'GET');
        return { humanMessageRead: received.event_id === event.event_id, agentReplyVisible: visible.event_id === reply.event_id };
      },
      close: cleanup,
    };
  } catch {
    try { await transport?.close(); }
    finally { try { synapse?.close(); } finally { rmSync(root, { recursive: true, force: true }); } }
    throw new Error('controlled_bootstrap_fixture_failed');
  }
}
