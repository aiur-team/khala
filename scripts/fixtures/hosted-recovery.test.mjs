import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { startRecoveryTransport } from './hosted-recovery.mjs';

function requestInNewProcess(fixture, pathname) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      try {
        const response = await fetch(process.argv[1], { method: 'POST' });
        const value = await response.json();
        console.log(JSON.stringify({ kind: value.kind, status: response.status }));
      } catch { console.log(JSON.stringify({ kind: 'response_lost' })); }
    `, fixture.origin + pathname], {
      env: { PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: fixture.caFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error('fixture_child_failed'));
      else { try { resolve({ pid: child.pid, ...JSON.parse(output) }); } catch { reject(new Error('fixture_child_invalid')); } }
    });
  });
}

test('commits an upstream redemption before response loss and preserves it across client processes', { timeout: 30_000 }, async () => {
  let commits = 0;
  const fixture = await startRecoveryTransport({
    async handle(request) {
      if (new URL(request.url).pathname === '/api/agent/channel-access/redeem') {
        commits += 1;
        return Response.json({ kind: 'admitted', privateCapability: 'must-not-appear-in-receipt' });
      }
      return Response.json({ kind: commits === 1 ? 'admitted' : 'unavailable' });
    },
  });
  try {
    const first = await requestInNewProcess(fixture, '/api/agent/channel-access/redeem');
    assert.equal(first.kind, 'response_lost');
    assert.equal(commits, 1);
    const second = await requestInNewProcess(fixture, '/api/agent/channel-access/resume');
    assert.equal(second.kind, 'admitted');
    assert.notEqual(first.pid, second.pid);
    assert.deepEqual(fixture.receipt(), { v: 1, scope: 'transport_only', requests: 2, completedAdapterResponses: 2, droppedRedeemResponses: 1 });
    assert.ok(!JSON.stringify(fixture.receipt()).includes('must-not-appear'));
  } finally { await fixture.close(); }
});

test('does not consume the drop on refusal or unrelated paths; drops at most one admitted redemption', { timeout: 30_000 }, async () => {
  let allow = false;
  const fixture = await startRecoveryTransport({ async handle() {
    return Response.json({ kind: allow ? 'admitted' : 'refused', code: 'admission_denied' }, { status: allow ? 200 : 403 });
  } });
  try {
    assert.equal((await requestInNewProcess(fixture, '/api/agent/channel-access/redeem')).kind, 'refused');
    allow = true;
    assert.equal((await requestInNewProcess(fixture, '/api/agent/channel-access/resume')).kind, 'admitted');
    assert.equal((await requestInNewProcess(fixture, '/api/agent/channel-access/redeem')).kind, 'response_lost');
    assert.equal((await requestInNewProcess(fixture, '/api/agent/channel-access/redeem')).kind, 'admitted');
    assert.equal(fixture.receipt().droppedRedeemResponses, 1);
  } finally { await fixture.close(); }
});

test('a child without the private CA cannot reach the adapter', { timeout: 30_000 }, async () => {
  const fixture = await startRecoveryTransport({ async handle() { throw new Error('untrusted_child_reached_adapter'); } });
  try {
    const result = await requestInNewProcess({ origin: fixture.origin, caFile: '' }, '/api/agent/channel-access/redeem');
    assert.equal(result.kind, 'response_lost');
    assert.equal(fixture.receipt().requests, 0);
  } finally { await fixture.close(); }
});
