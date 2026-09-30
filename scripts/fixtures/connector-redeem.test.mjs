// Protocol regression only: real connector HTTP client; stand-in hosted authority, no installed CLI/Matrix proof.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { startRecoveryTransport } from './hosted-recovery.mjs';

const repository = fileURLToPath(new URL('../..', import.meta.url));
function connectorProcess(fixture, keyFile, action) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--conditions=khala-source', '--input-type=module', '-e', `
      import { readFileSync } from 'node:fs';
      import { createPrivateKey } from 'node:crypto';
      import { createProofSigner } from './packages/connector/src/bootstrap/proof.ts';
      import { createHttpChannelAccessRedeem } from './packages/connector/src/bootstrap/channel-access-http.ts';
      const [origin, keyFile, action] = process.argv.slice(1);
      const signer = createProofSigner(createPrivateKey(readFileSync(keyFile)));
      const credential = { credentialRef: 'controlled-discovery-credential', requester: {
        principal: 'agent_' + signer.jkt, origin, sessionGeneration: 3,
        proofKey: { algorithm: 'Ed25519', publicKey: signer.publicKey, thumbprint: signer.jkt }
      } };
      const client = createHttpChannelAccessRedeem({ signer, trustedOrigins: [origin], credential: () => credential });
      const result = await client[action]({ operationId: 'controlled-redeem-operation', deviceId: 'CONTROLLED_DEVICE',
        origin, ...(action === 'redeem' ? { grant: 'controlled-fixture-grant' } : {}) });
      console.log(JSON.stringify({ kind: result.kind }));
    `, fixture.origin, keyFile, action], { cwd: repository,
      env: { PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: fixture.caFile }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.resume();
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('connector_fixture_start_failed')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error('connector_fixture_failed')); return; }
      try { resolve({ pid: child.pid, ...JSON.parse(output) }); }
      catch { reject(new Error('connector_fixture_invalid_reply')); }
    });
  });
}

test('drops the actual channel grant bootstrap redemption before a new connector process resumes', { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'khala-connector-redeem-'));
  const keyFile = path.join(directory, 'proof.pem');
  writeFileSync(keyFile, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  let fixture;
  let redemptions = 0;
  let resumed = 0;
  const signerKeys = new Set();
  try {
    fixture = await startRecoveryTransport({ async handle(request) {
      const url = new URL(request.url);
      const proof = request.headers.get('dpop');
      assert.ok(proof);
      const header = JSON.parse(Buffer.from(proof.split('.')[0], 'base64url'));
      const claims = JSON.parse(Buffer.from(proof.split('.')[1], 'base64url'));
      signerKeys.add(header.jwk.x);
      assert.equal(claims.htm, 'POST');
      assert.equal(claims.htu, request.url);
      const body = await request.json();
      if (url.pathname === '/api/agent/bootstrap/redeem') {
        assert.equal(body.operation_id, 'controlled-redeem-operation');
        assert.equal(body.device_id, 'CONTROLLED_DEVICE');
        redemptions += 1;
      } else {
        assert.equal(url.pathname, '/api/agent/channel-access/resume');
        assert.equal(body.bindingId, undefined);
        assert.equal(body.grant, undefined);
        resumed += 1;
      }
      // Actual bootstrap wire shape: there is no top-level kind: admitted.
      return Response.json({ binding: { v: 1, bindingId: 'bnd_controlled', ownerId: 'owner_controlled',
        agentParticipantId: 'agent_controlled', deviceId: 'CONTROLLED_DEVICE', harness: 'proof-key',
        sessionId: body.requester ?? body.session_id, generation: 3 },
        adapter_capability: { token: 'A'.repeat(43), token_type: 'DPoP',
          scope: ['publish_own', 'receive_released', 'ack_delivery'], binding_id: 'bnd_controlled',
          generation: 3, expires_at: Date.now() + 60_000 } });
    } });
    const first = await connectorProcess(fixture, keyFile, 'redeem');
    assert.equal(first.kind, 'outcome_unknown');
    assert.equal(redemptions, 1);
    assert.equal(fixture.receipt().droppedRedeemResponses, 1);
    const second = await connectorProcess(fixture, keyFile, 'resume');
    assert.equal(second.kind, 'admitted');
    assert.notEqual(first.pid, second.pid);
    assert.equal(redemptions, 1);
    assert.equal(resumed, 1);
    assert.equal(signerKeys.size, 1);
    console.log(JSON.stringify({ v: 1, scope: 'connector_protocol_only', processes: 2,
      redeemRequests: 1, resumeRequests: 1, proofKeys: 1, droppedRedeemResponses: 1 }));
  } finally { await fixture?.close(); rmSync(directory, { recursive: true, force: true }); }
});
