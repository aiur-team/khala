import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startApprovedBootstrapFixture } from './bootstrap-synapse.mjs';

test('real bootstrap keeps one binding and device login after a dropped response and refused replay', { timeout: 180_000 }, async () => {
  const fixture = await startApprovedBootstrapFixture();
  try {
    assert.equal(await fixture.request(), 'pending');
    assert.deepEqual(fixture.counts(), { grants: 0, bindings: 0, agentDeviceLogins: 0, totalAdapterLogins: 0 });
    assert.equal(await fixture.approve(), 'approved');
    const wrongDevice = await fixture.client({ deviceId: 'OTHER_DEVICE' });
    assert.equal(wrongDevice.kind, 'refused');
    assert.equal(wrongDevice.code, 'ownership_required');
    assert.equal(fixture.counts().agentDeviceLogins, 0);
    const wrongGeneration = await fixture.client({ session: { harness: 'codex', sessionId: 'controlled-synapse-session', generation: 4 } });
    assert.equal(wrongGeneration.kind, 'refused');
    assert.equal(wrongGeneration.code, 'ownership_required');
    const first = await fixture.client();
    assert.equal(first.kind, 'outcome_unknown');
    assert.equal(fixture.droppedRedeemResponses(), 1);
    assert.deepEqual(fixture.counts(), { grants: 1, bindings: 1, agentDeviceLogins: 1, totalAdapterLogins: 4 });
    await fixture.restartControl();
    const originalBindingPreserved = await fixture.originalBindingPreserved();
    assert.equal(originalBindingPreserved, true);
    const retry = await fixture.client();
    assert.notEqual(first.pid, retry.pid);
    assert.equal(retry.kind, 'refused');
    assert.equal(retry.code, 'ownership_required');
    assert.deepEqual(fixture.counts(), { grants: 1, bindings: 1, agentDeviceLogins: 1, totalAdapterLogins: 4 });
    assert.deepEqual(await fixture.matrixExchange(), { humanMessageRead: true, agentReplyVisible: true });
    console.log(JSON.stringify({ v: 1, scope: 'bootstrap_synapse_only', processes: 4,
      originalBindingPreserved, ...fixture.counts(), droppedRedeemResponses: fixture.droppedRedeemResponses(),
      replay: 'ownership_required', humanMessageRead: true, agentReplyVisible: true }));
  } finally { await fixture.close(); }
});
